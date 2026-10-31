import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { settings } from "@/nextsignal/config";
import { pool, transaction } from "@/nextsignal/services/database";
import { seedRetailers } from "@/nextsignal/services/catalog-repository";
import {
  readSettings,
  saveSettings,
} from "@/nextsignal/services/task-settings";
import { createTask, executeTask } from "@/nextsignal/services/tasks";
import { classificationRequest } from "@/nextsignal/services/ai-gateway";
import {
  getProduct,
  saveClassification,
  findCandidates,
} from "@/nextsignal/services/matching-repository";
import { withTaskContext } from "@/nextsignal/services/task-context";
import { identityCatalog } from "@/nextsignal/services/identity-catalog";
import { prepareIdentity } from "@/nextsignal/domain/matching-identity";
import { matchingRules } from "@/nextsignal/services/brand-catalog";
import { hash } from "@/nextsignal/domain/normalize";
import type { StoreProduct } from "@/nextsignal/domain/matching";
import type { TaskCommand } from "@/nextsignal/domain/task-settings";
const args = process.argv.slice(2),
  paid = args.includes("--paid");
const positions = args.filter((a) => !a.startsWith("--"));
const path = positions[0] ?? settings.matching.evaluation.identity_dataset_path,
  output = positions[1] ?? settings.matching.evaluation.identity_report_path;
const expectedSchema = z.object({
  a: z.uuid(),
  b: z.uuid(),
  expected: z.enum(["same", "different", "insufficient"]),
  reviewed: z.literal(true),
  control: z.boolean(),
});
try {
  if (!new URL(settings.database.url).pathname.endsWith("_matching_test"))
    throw new Error("Identity evaluation refuses application databases");
  const data = JSON.parse(await readFile(path, "utf8")) as {
    products: StoreProduct[];
    anchors: string[];
    cases: unknown[];
    review_complete: boolean;
    profile_version: string;
    seed: string;
    brands?: { id: string; slug: string; name: string }[];
    brand_aliases?: {
      id: string;
      brand_id: string;
      name: string;
      normalized_name: string;
      retailer: string | null;
    }[];
  };
  if (data.profile_version !== hash(identityCatalog))
    throw new Error(
      "Profile version changed after the dataset was frozen; freeze and review again",
    );
  if (
    !data.anchors.length ||
    new Set(data.anchors).size !== data.anchors.length
  )
    throw new Error("Unique explicit anchor list required");
  if (paid && (!data.review_complete || !data.cases.length))
    throw new Error(
      "Review and freeze expected groups/differences before paid evaluation",
    );
  if (paid && (!data.brands || !data.brand_aliases))
    throw new Error(
      "The source brand dictionary snapshot is required for paid evaluation",
    );
  const cases = data.cases.map((x) => expectedSchema.parse(x));
  if (
    paid &&
    cases.filter((c) => c.control).length <
      settings.matching.evaluation.identity_controls
  )
    throw new Error("The required difficult controls have not been reviewed");
  const allIds = new Set(data.products.map((p) => p.id));
  if (
    data.anchors.some((id) => !allIds.has(id)) ||
    cases.some((c) => !allIds.has(c.a) || !allIds.has(c.b))
  )
    throw new Error("Evaluation references missing source products");
  if (!paid)
    globalThis.fetch = async () => {
      throw new Error("Offline evaluation cannot call external providers");
    };
  await pool.query(
    "TRUNCATE retailers,products,runs,sources,task_executions,operational_settings,operational_settings_history CASCADE",
  );
  await seedRetailers();
  await transaction(async (c) => {
    if (data.brands && data.brand_aliases) {
      await c.query("TRUNCATE brands CASCADE");
      for (const b of data.brands)
        await c.query("INSERT INTO brands(id,slug,name) VALUES($1,$2,$3)", [
          b.id,
          b.slug,
          b.name,
        ]);
      for (const a of data.brand_aliases)
        await c.query(
          "INSERT INTO brand_aliases(id,brand_id,name,normalized_name,retailer) VALUES($1,$2,$3,$4,$5)",
          [a.id, a.brand_id, a.name, a.normalized_name, a.retailer],
        );
    }
    const groups = new Set<string>();
    for (const p of data.products) {
      if (!groups.has(p.group_id)) {
        await c.query(
          "INSERT INTO products(id,name,normalized_name,attributes) VALUES($1,$2,$3,'{}')",
          [p.group_id, p.name, p.normalized_name],
        );
        groups.add(p.group_id);
      }
      await c.query(
        "INSERT INTO store_products(id,retailer,external_key,fingerprint,source_identity_hash,name,description,category,gtin,normalized_name,ambiguous,facts,family,category_hints,local_key,group_id,manual_facts,manual_family,category_review_source,classified_family) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,'[]',$13,$14,$15,$16,$17,$18)",
        [
          p.id,
          p.retailer,
          p.external_key,
          p.fingerprint,
          p.name,
          p.description,
          p.category,
          p.gtin,
          p.normalized_name,
          p.ambiguous,
          p.facts,
          p.family,
          p.local_key,
          p.group_id,
          p.manual_facts ?? {},
          p.manual_family ?? null,
          p.category_review_source ?? null,
          p.classified_family ?? p.manual_family ?? null,
        ],
      );
    }
    for (const retailer of new Set(data.products.map((p) => p.retailer))) {
      const source = (
        await c.query(
          "INSERT INTO sources(retailer,external_id,name,url,scope,meta,availability_indexed_at) VALUES($1,'identity-evaluation','Isolated identity evaluation',$2,'retailer','{}',now()) RETURNING id",
          [retailer, settings.sources[retailer].url],
        )
      ).rows[0].id;
      await c.query(
        "INSERT INTO store_product_sources(store_product_id,source_id,price,highest_price,offer_count,retrieved_at,available) SELECT id,$2,1,1,1,now(),true FROM store_products WHERE retailer=$1",
        [retailer, source],
      );
    }
  });
  await pool.query(
    "INSERT INTO matching_prompt_versions(key,files) VALUES('identity-evaluation-source-labels','[]') ON CONFLICT DO NOTHING",
  );
  for (const source of data.products) {
    const p = await getProduct(source.id);
    await saveClassification(p, {
      key: (await classificationRequest(p)).key,
      family: source.classified_family ?? source.family,
      hints: [],
      selected: source.classified_family ?? source.family,
      probabilities: { [source.classified_family ?? source.family]: 1 },
      model: "saved-source-category",
      prompt_key: "identity-evaluation-source-labels",
      confidence: null,
      generation_id: null,
    });
  }
  let saved = await readSettings();
  saved = await saveSettings(
    saved.revision,
    {
      ...saved.policy,
      ai_enabled: paid,
      clarification_enabled: paid,
      matching: "manual",
      task_budget_usd: settings.matching.evaluation.identity_paid_budget_usd,
    },
    "isolated-evaluation",
  );
  const task = await createTask(
    {
      revision: saved.revision,
      kind: "match",
      retailers: Object.keys(settings.sources) as TaskCommand["retailers"],
      source_id: null,
      product_limit: data.anchors.length,
      use_ai: paid,
      categories: paid ? ["soft_drinks", "dairy"] : [],
      max_cost_usd: paid
        ? settings.matching.evaluation.identity_paid_budget_usd
        : 0,
      counterpart_limit: saved.policy.counterpart_limit,
      recheck: true,
      idempotency_key: randomUUID(),
    },
    "isolated-evaluation",
  );
  for (const id of data.anchors) {
    const p = await getProduct(id);
    await pool.query(
      "INSERT INTO task_items(task_id,input_id,store_product_id,group_id,input_hash,input_version) VALUES($1,$2,$2,$3,$4,$5)",
      [
        task.id,
        id,
        p.group_id,
        hash([p.fingerprint, p.manual_facts]),
        p.version,
      ],
    );
  }
  await pool.query("UPDATE task_executions SET selected=$2 WHERE id=$1", [
    task.id,
    data.anchors.length,
  ]);
  const retrieved = new Map<string, Set<string>>();
  await withTaskContext(task, saved, async () => {
    for (const id of data.anchors) {
      const raw = await getProduct(id);
      const p = prepareIdentity(
        raw,
        await matchingRules(undefined, raw.retailer),
        settings.matching.category_mappings,
        identityCatalog,
      );
      retrieved.set(
        id,
        new Set(
          [
            ...new Map(
              [
                ...(await findCandidates(p, "rules")),
                ...(paid ? await findCandidates(p, "ai") : []),
              ].map((c) => [c.product.group_id, c]),
            ).values(),
          ]
            .slice(0, settings.matching.candidate_limit)
            .flatMap((c) => c.members.map((m) => m.id)),
        ),
      );
    }
  });
  const started = Date.now();
  for (let batch = 0; batch <= data.anchors.length; batch++) {
    await executeTask(task.id);
    const state = (
      await pool.query(
        "SELECT state,processed FROM task_executions WHERE id=$1",
        [task.id],
      )
    ).rows[0];
    if (state.state !== "queued") break;
    if (batch === data.anchors.length)
      throw new Error("Evaluation exceeded its bounded checkpoint count");
  }
  const actual = (
    await pool.query<{ id: string; group_id: string }>(
      "SELECT id,group_id FROM store_products",
    )
  ).rows;
  const group = new Map(actual.map((p) => [p.id, p.group_id]));
  const results = cases.map((c) => ({
    ...c,
    retrieved:
      (retrieved.get(c.a)?.has(c.b) ?? false) ||
      (retrieved.get(c.b)?.has(c.a) ?? false),
    connected: group.get(c.a) === group.get(c.b),
  }));
  const anchors = new Set(data.anchors);
  const positives = results.filter(
      (c) => c.expected === "same" && (anchors.has(c.a) || anchors.has(c.b)),
    ),
    accepted = results.filter((c) => c.connected),
    wrong = accepted.filter((c) => c.expected !== "same");
  const usage = (
    await pool.query(
      "SELECT count(*)::int requests,coalesce(sum(cost_usd),0)::text cost_usd FROM ai_usage WHERE task_id=$1",
      [task.id],
    )
  ).rows[0];
  const state = (
    await pool.query(
      "SELECT state,reason,processed,connected,unresolved,checkpoint FROM task_executions WHERE id=$1",
      [task.id],
    )
  ).rows[0];
  const knownPairs = new Set(cases.map((c) => [c.a, c.b].sort().join(":")));
  const joined: { a: string; b: string }[] = [];
  const groupMembers = new Map<string, string[]>();
  for (const p of actual) {
    const ids = groupMembers.get(p.group_id) ?? [];
    ids.push(p.id);
    groupMembers.set(p.group_id, ids);
  }
  for (const ids of groupMembers.values())
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        if (!knownPairs.has([ids[i], ids[j]].sort().join(":")))
          joined.push({ a: ids[i], b: ids[j] });
  const sampleComplete =
    data.anchors.length >=
      settings.matching.evaluation.identity_anchors_per_family * 2 &&
    positives.length >= 20 &&
    cases.filter((c) => c.control).length >=
      settings.matching.evaluation.identity_controls;
  const report = {
    mode: paid ? "paid-isolated" : "offline-code-only",
    dataset: path,
    seed: data.seed,
    profile_version: hash(identityCatalog),
    task: state,
    usage,
    duration_ms: Date.now() - started,
    cache_reuse: {
      pair_answer_lookups: Number(state.checkpoint.pair_cache_hits ?? 0),
    },
    unresolved_reasons: (
      await pool.query(
        "SELECT reason,count(*)::int products FROM task_items WHERE task_id=$1 AND state IN('unresolved','deferred') GROUP BY reason ORDER BY count(*) DESC",
        [task.id],
      )
    ).rows,
    group_coverage: {
      connected_primary_products: (
        await pool.query(
          "SELECT count(*)::int count FROM store_products sp WHERE sp.id=ANY($1::uuid[]) AND EXISTS(SELECT 1 FROM store_products other WHERE other.group_id=sp.group_id AND other.retailer<>sp.retailer)",
          [data.anchors],
        )
      ).rows[0].count,
      total_primary_products: data.anchors.length,
    },
    summary: {
      verified_positive_pairs: positives.length,
      correct_connections: positives.filter((c) => c.connected).length,
      incorrect_connections: wrong.length,
      retrieval_coverage: positives.length
        ? positives.filter((c) => c.retrieved).length / positives.length
        : null,
      accepted_match_recall: positives.length
        ? positives.filter((c) => c.connected).length / positives.length
        : null,
      precision_on_reviewed_pairs: accepted.length
        ? (accepted.length - wrong.length) / accepted.length
        : null,
    },
    unreviewed_connections: joined,
    sample_complete: sampleComplete,
    acceptance_met:
      paid &&
      sampleComplete &&
      joined.length === 0 &&
      state.state === "completed" &&
      state.processed === data.anchors.length &&
      positives.length > 0 &&
      wrong.length === 0 &&
      positives.filter((c) => c.retrieved).length / positives.length >= 0.95 &&
      positives.filter((c) => c.connected).length / positives.length >= 0.8,
    results,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      output,
      ...report.summary,
      ...usage,
      state: state.state,
      acceptance_met: report.acceptance_met,
    }),
  );
} finally {
  await pool.end();
}
