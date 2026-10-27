import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { settings } from "@/nextsignal/config";
import { pool, transaction } from "@/nextsignal/services/database";
import { seedRetailers } from "@/nextsignal/services/catalog-repository";
import { evaluationDataset } from "@/nextsignal/domain/matching-evaluation";
import {
  familyFromText,
  prepareFacts,
  inputFingerprint,
  localKey,
} from "@/nextsignal/domain/matching";
import { normalizeName } from "@/nextsignal/domain/normalize";
import {
  ensureCampaign,
  claimWork,
  finishWork,
  pauseCampaign,
  completeCampaign,
  recordResult,
} from "@/nextsignal/services/matching-repository";
import { processStoreProduct } from "@/nextsignal/services/matching-workflow";
import { GatewayDeferred } from "@/nextsignal/services/ai-gateway";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const path = positional[0] ?? "tests/fixtures/store-matching-evaluation.json";
const split = args.includes("--holdout") ? "holdout" : "development";
const output =
  positional[1] ?? `.data/matching-evaluation/${split}-${Date.now()}.json`;
const stableId = (text: string) => {
  const s = createHash("sha256").update(text).digest("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}`;
};
if (!new URL(settings.database.url).pathname.endsWith("_matching_test"))
  throw new Error(
    "Evaluation refuses application and normal test databases. Use npm run matching:evaluate.",
  );
if (settings.matching.automatic_enabled)
  throw new Error("Automatic matching must remain disabled in evaluation.");
if (settings.matching.gateway.enabled !== args.includes("--paid"))
  throw new Error("Paid evaluation requires the explicit --paid argument.");
try {
  const dataset = evaluationDataset.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  const cases = dataset.cases.filter((c) => c.split === split);
  if (!cases.length || cases.some((c) => !c.reviewed || c.expected === null))
    throw new Error(
      "This split needs human-verified expected outcomes before evaluation. No provider requests were sent.",
    );
  const ids = new Set(cases.flatMap((c) => [c.a, c.b]));
  const products = dataset.products.filter(
    (p) => p.split === split && ids.has(p.id),
  );
  if (products.length !== ids.size)
    throw new Error("Missing product or split leakage in evaluation cases.");
  if (new Set(products.map((p) => p.id)).size !== products.length)
    throw new Error("Duplicate evaluation product ID.");
  // Only this disposable evaluation database is reset; caches remain reusable.
  await pool.query("TRUNCATE retailers,products,runs,sources,listings CASCADE");
  await seedRetailers();
  const campaign = await ensureCampaign("evaluation");
  await transaction(async (c) => {
    for (const product of products) {
      const family = familyFromText(
        product,
        product.retailer,
        settings.matching.category_mappings,
      );
      const facts = prepareFacts(product, family, settings.matching.local),
        group = stableId(`group:${product.id}`),
        source = stableId(`source:${product.retailer}`);
      await c.query(
        `INSERT INTO sources(id,retailer,external_id,name,url,scope,meta) VALUES($1,$2,'evaluation','Evaluation catalog',$3,'retailer','{}') ON CONFLICT DO NOTHING`,
        [source, product.retailer, settings.sources[product.retailer].url],
      );
      await c.query(
        `INSERT INTO products(id,name,normalized_name,attributes) VALUES($1,$2,$3,'{}')`,
        [group, product.name, normalizeName(product.name)],
      );
      await c.query(
        `INSERT INTO store_products(id,retailer,external_key,fingerprint,source_identity_hash,name,description,category,gtin,normalized_name,ambiguous,facts,family,category_hints,local_key,group_id)
     VALUES($1,$2,$14,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]',$12,$13)`,
        [
          product.id,
          product.retailer,
          inputFingerprint(product),
          product.name,
          product.description,
          product.category,
          product.gtin,
          normalizeName(product.name),
          product.ambiguous,
          JSON.stringify(facts),
          family,
          localKey(
            product.name,
            facts,
            product.ambiguous,
            settings.matching.local,
          ),
          group,
          product.id,
        ],
      );
      await c.query(
        `INSERT INTO store_product_sources(store_product_id,source_id,price,highest_price,offer_count,retrieved_at) VALUES($1,$2,NULL,NULL,1,now())`,
        [product.id, source],
      );
      await c.query(
        `INSERT INTO matching_work(store_product_id,campaign_id,reason) VALUES($1,$2,'Isolated dataset evaluation')`,
        [product.id, campaign.id],
      );
    }
  });
  const retrieval = new Map<string, Set<string>>();
  const { getProduct, findCandidates } =
    await import("@/nextsignal/services/matching-repository");
  for (const id of ids) {
    const p = await getProduct(id);
    retrieval.set(
      id,
      new Set(
        (await findCandidates(p)).flatMap((c) => c.members.map((m) => m.id)),
      ),
    );
  }
  let stopped: string | null = null;
  while (!stopped) {
    // New facts or a group connection can wake an already processed neighbor.
    // Keep that follow-up inside this evaluation and its original allowance.
    await pool.query(
      `UPDATE matching_work SET campaign_id=$1 WHERE campaign_id IS NULL
       AND state='pending' AND store_product_id=ANY($2::uuid[])`,
      [campaign.id, [...ids]],
    );
    const work = await claimWork(campaign.id);
    if (!work.length) break;
    for (const item of work) {
      try {
        await processStoreProduct(item, campaign);
      } catch (error) {
        if (!(error instanceof GatewayDeferred)) throw error;
        if (error.reason === "invalid") {
          const product = await getProduct(item.store_product_id);
          await recordResult(
            product,
            item,
            [],
            `evaluation-invalid:${product.fingerprint}`,
            error.message,
            "needs_info",
          );
          await finishWork(item, "invalid", "completed");
          continue;
        }
        stopped = error.message;
        await finishWork(item, "deferred", "deferred", stopped);
        await pauseCampaign(campaign.id, stopped);
        break;
      }
    }
  }
  if (!stopped) await completeCampaign(campaign.id);
  const state = (
    await pool.query<{ id: string; group_id: string; state: string }>(
      "SELECT * FROM store_products ORDER BY id",
    )
  ).rows;
  const groups = new Map(state.map((p) => [p.id, p.group_id]));
  const results = cases.map((c) => ({
    ...c,
    connected: groups.get(c.a) === groups.get(c.b),
    retrieved:
      retrieval.get(c.a)?.has(c.b) || retrieval.get(c.b)?.has(c.a) || false,
  }));
  const positives = results.filter((c) => c.expected === "same");
  const falseLinks = results.filter(
    (c) => c.expected !== "same" && c.connected,
  );
  const expectedParent = new Map(products.map((p) => [p.id, p.id]));
  const root = (id: string): string =>
    expectedParent.get(id) === id ? id : root(expectedParent.get(id)!);
  for (const c of positives) expectedParent.set(root(c.b), root(c.a));
  const key = (a: string, b: string) => [a, b].sort().join(":");
  const labeled = new Set(results.map((c) => key(c.a, c.b)));
  const actualMembers = new Map<string, string[]>();
  for (const product of state)
    actualMembers.set(product.group_id, [
      ...(actualMembers.get(product.group_id) ?? []),
      product.id,
    ]);
  const unreviewedConnections: { a: string; b: string }[] = [];
  for (const members of actualMembers.values())
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i],
          b = members[j];
        if (root(a) !== root(b) && !labeled.has(key(a, b)))
          unreviewedConnections.push({ a, b });
      }
  const usage = (
    await pool.query(
      `SELECT count(*)::int AS requests,coalesce(sum(cost_usd),0)::text AS cost_usd FROM ai_usage WHERE campaign_id=$1`,
      [campaign.id],
    )
  ).rows[0];
  const providerUsage = (
    await pool.query(
      `SELECT model,status,count(*)::int AS requests,sum(input_tokens)::text AS input_tokens,
     sum(output_tokens)::text AS output_tokens,sum(cost_usd)::text AS cost_usd
     FROM ai_usage WHERE campaign_id=$1 GROUP BY model,status ORDER BY model,status`,
      [campaign.id],
    )
  ).rows;
  const workState = (
    await pool.query(
      "SELECT state,count(*)::int AS count FROM matching_work GROUP BY state ORDER BY state",
    )
  ).rows;
  const expectedGroups = new Map<string, string[]>();
  for (const product of products)
    expectedGroups.set(root(product.id), [
      ...(expectedGroups.get(root(product.id)) ?? []),
      product.id,
    ]);
  const positiveGroups = [...expectedGroups.values()].filter(
    (ids) => ids.length > 1,
  );
  const completeGroups = positiveGroups.filter((ids) => {
    const group = groups.get(ids[0]);
    return (
      ids.every((id) => groups.get(id) === group) &&
      actualMembers.get(group!)?.length === ids.length
    );
  });
  const decisions = (
    await pool.query(
      "SELECT store_product_id,candidate_id,outcome,reason,probability,confidence,model FROM store_match_decisions ORDER BY created_at",
    )
  ).rows;
  const report = {
    dataset: path,
    seed: dataset.seed,
    provenance: dataset.provenance,
    split,
    paid: args.includes("--paid"),
    stopped,
    configuration: {
      rules_version: settings.matching.rules_version,
      prompt_version: settings.matching.prompt_version,
      local_rules_version: settings.matching.local.version,
      matching_threshold: settings.matching.threshold,
      ai_categories: settings.matching.ai_categories,
      decision_model: settings.matching.gateway.decision_model,
      extraction_model: settings.matching.gateway.extraction_model,
      automatic_matching: settings.matching.automatic_enabled,
    },
    summary: {
      cases: results.length,
      correct_connections: positives.filter((c) => c.connected).length,
      incorrect_connections: falseLinks.length,
      unreviewed_connections: unreviewedConnections.length,
      unresolved: positives.filter((c) => !c.connected).length,
      verified_positive_pairs: positives.length,
      retrieved_positive_pairs: positives.filter((c) => c.retrieved).length,
      complete_groups: completeGroups.length,
      expected_groups: positiveGroups.length,
      ...usage,
    },
    products,
    results,
    decisions,
    actual_products: state,
    provider_usage: providerUsage,
    usage_by_operation: (
      await pool.query(
        `SELECT operation,count(*)::int AS requests,sum(input_tokens)::text AS input_tokens,sum(output_tokens)::text AS output_tokens,sum(cost_usd)::text AS cost_usd FROM ai_usage WHERE campaign_id=$1 GROUP BY operation ORDER BY operation`,
        [campaign.id],
      )
    ).rows,
    category_counts: (
      await pool.query(
        "SELECT classified_family,count(*)::int AS products FROM store_products GROUP BY classified_family ORDER BY classified_family",
      )
    ).rows,
    work_state: workState,
    unreviewed_connections: unreviewedConnections,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2), { flag: "wx" });
  const markdown = output.replace(/\.json$/, ".md");
  await writeFile(
    markdown,
    `# Matching evaluation: ${split}\n\n${dataset.provenance}\n\n${report.summary.correct_connections} correct connections; ${falseLinks.length} incorrect connections; ${report.summary.unresolved} unresolved positive pairs.\n\nRequests: ${usage.requests}. Reported or reserved cost: $${usage.cost_usd}.\n\n| Source product | Counterpart | Expected | Connected |\n| --- | --- | --- | --- |\n${results.map((c) => `| ${products.find((p) => p.id === c.a)?.name.replaceAll("|", "/")} | ${products.find((p) => p.id === c.b)?.name.replaceAll("|", "/")} | ${c.expected} | ${c.connected ? "Yes" : "No"} |`).join("\n")}\n\nThese diagnostic examples do not establish general catalog accuracy. Automatic matching remains disabled.\n`,
    { flag: "wx" },
  );
  console.info({
    summary: report.summary,
    stopped,
    report: output,
    readable_report: markdown,
    automatic_matching: false,
  });
  if (
    falseLinks.length ||
    unreviewedConnections.length ||
    !report.summary.correct_connections ||
    stopped
  )
    process.exitCode = 1;
} finally {
  await pool.end();
}
