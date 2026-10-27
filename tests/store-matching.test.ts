import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import { matchBatch } from "@/nextsignal/services/matching";
import {
  detailsForProduct,
  offersForProduct,
} from "@/nextsignal/services/product-browser";
import * as repo from "@/nextsignal/services/matching-repository";
import {
  familyFromText,
  prepareFacts,
  inputFingerprint,
  differences,
  enoughEvidence,
  groupProblem,
  localKey,
  type StoreProduct,
} from "@/nextsignal/domain/matching";
import { normalizeName } from "@/nextsignal/domain/normalize";
import { decide, compare, clarify } from "@/nextsignal/services/ai-gateway";
import type { CatalogRow, Retailer } from "@/nextsignal/domain/types";
const original = structuredClone(settings.matching);
const name = "Coca-Cola Original 6 x 330 ml cans";
function row(key: string, label = name, price = "50.00"): CatalogRow {
  return {
    key,
    name: label,
    description: null,
    category: null,
    gtin: null,
    price,
    regular_price: null,
    promo_price: null,
    unit_price: null,
    available: true,
    promotion: null,
    source_updated_at: null,
    raw: {},
  };
}
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Dedicated test database required");
  vi.restoreAllMocks();
  Object.assign(settings.matching, structuredClone(original));
  await pool.query("TRUNCATE retailers,products,runs,listings,sources CASCADE");
  await pool.query("DELETE FROM ai_cache");
  await pool.query(
    `UPDATE matching_state SET cursor=NULL,completed=false WHERE key='store-products'`,
  );
  await seedRetailers();
});
afterAll(async () => {
  Object.assign(settings.matching, original);
  vi.restoreAllMocks();
  await pool.end();
});
async function publish(retailer: Retailer, rows: CatalogRow[], branch = "one") {
  const source = (
    await pool.query(
      `INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,$2,$3,'branch','{}') ON CONFLICT(retailer,external_id) DO UPDATE SET active=true RETURNING id`,
      [retailer, branch, settings.sources[retailer].url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", retailer, source, null);
  await stagePage(run, {
    rows,
    next: null,
    total: rows.length,
    artifact: null,
  });
  await publishCatalog(await getRun(run.id));
  return { source, run };
}
async function match() {
  const run = await createRun("match", null, null, null);
  let summary = await matchBatch(run.id, null);
  let batches = 1;
  while (summary.more && batches++ < 10)
    summary = await matchBatch(run.id, null);
  return summary;
}
function prepared(label: string, retailer = "kam"): StoreProduct {
  const input = {
    name: label,
    category: null,
    description: null,
    gtin: null,
    ambiguous: false,
  };
  const family = familyFromText(
      input,
      retailer,
      settings.matching.category_mappings,
    ),
    facts = prepareFacts(input, family, settings.matching.local);
  return {
    ...input,
    id: retailer,
    retailer,
    external_key: "item",
    fingerprint: inputFingerprint(input),
    normalized_name: normalizeName(label),
    facts,
    family,
    category_hints: [],
    local_key: localKey(label, facts, false, settings.matching.local),
    group_id: retailer,
    version: 1,
    state: "pending",
    last_reason: "New",
  };
}
it("forms a nine-chain group from unmatched products without comparing branch copies", async () => {
  for (const retailer of Object.keys(settings.sources) as Retailer[])
    await publish(retailer, [row("cola")]);
  await publish("kam", [row("cola", name, "49.00")], "two");
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await match();
  expect((await pool.query("SELECT * FROM store_products")).rowCount).toBe(9);
  expect((await pool.query("SELECT * FROM offers")).rowCount).toBe(10);
  expect(
    (
      await pool.query(
        "SELECT count(DISTINCT group_id)::int AS n FROM store_products",
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (await pool.query(`SELECT * FROM store_products WHERE state='matched'`))
      .rowCount,
  ).toBe(9);
  expect(fetchMock).not.toHaveBeenCalled();
});
it("price-only updates, extra branches, and normalized spelling preserve the connection and work", async () => {
  await publish("kam", [row("cola")]);
  await publish("spar", [row("cola")]);
  await match();
  const before = (
    await pool.query("SELECT id,group_id FROM store_products ORDER BY id")
  ).rows;
  const work = (
    await pool.query("SELECT id,state FROM matching_work ORDER BY id")
  ).rows;
  await publish("kam", [
    row("cola", "COCA-COLA ORIGINAL 6 x 330 ml CANS", "51.00"),
  ]);
  await publish("kam", [row("cola", name, "52.00")], "two");
  expect(
    (await pool.query("SELECT id,group_id FROM store_products ORDER BY id"))
      .rows,
  ).toEqual(before);
  expect(
    (await pool.query("SELECT id,state FROM matching_work ORDER BY id")).rows,
  ).toEqual(work);
});
it("a changed size creates a new revision and preserves the original information and history", async () => {
  await publish("kam", [row("cola")]);
  await publish("spar", [row("cola")]);
  await match();
  const old = (
    await pool.query(`SELECT * FROM store_products WHERE retailer='kam'`)
  ).rows[0];
  await publish("kam", [row("cola", "Coca-Cola Original 6 x 500 ml cans")]);
  expect(
    (await pool.query(`SELECT * FROM store_products WHERE retailer='kam'`))
      .rowCount,
  ).toBe(2);
  expect(
    (
      await pool.query("SELECT name,group_id FROM store_products WHERE id=$1", [
        old.id,
      ])
    ).rows[0],
  ).toMatchObject({ name, group_id: old.group_id });
  expect(
    (await pool.query("SELECT * FROM product_membership_history")).rowCount,
  ).toBeGreaterThan(1);
  const current = (
    await pool.query(
      `SELECT sp.* FROM store_products sp JOIN store_product_aliases a ON a.store_product_id=sp.id JOIN listings l ON l.id=a.listing_id WHERE l.retailer='kam'`,
    )
  ).rows[0];
  expect(current.group_id).not.toBe(old.group_id);
});
it("removed offers leave matching memory and returning products reuse it", async () => {
  await publish("kam", [row("cola")]);
  await publish("spar", [row("cola")]);
  await match();
  const old = (
    await pool.query(`SELECT * FROM store_products WHERE retailer='kam'`)
  ).rows[0];
  await publish("kam", [row("other", "Pepsi Original 1 x 500 ml can")]);
  expect(
    (
      await pool.query(
        "SELECT * FROM store_product_sources WHERE store_product_id=$1",
        [old.id],
      )
    ).rowCount,
  ).toBe(0);
  await publish("kam", [
    row("cola"),
    row("other", "Pepsi Original 1 x 500 ml can"),
  ]);
  expect(
    (
      await pool.query(
        `SELECT group_id,state FROM store_products WHERE id=$1`,
        [old.id],
      )
    ).rows[0],
  ).toMatchObject({ group_id: old.group_id, state: "matched" });
});
it("cannot merge two different items from one chain through a shared candidate", async () => {
  await publish("kam", [row("a"), row("b")]);
  await publish("spar", [row("a")]);
  await match();
  const groups = (
    await pool.query("SELECT DISTINCT group_id FROM store_products")
  ).rowCount;
  expect(groups).toBe(3);
  expect(
    (
      await pool.query(
        `SELECT * FROM store_match_decisions WHERE reason ILIKE '%same store%'`,
      )
    ).rowCount,
  ).toBeGreaterThan(0);
});
it("leaves competing same-store entries unresolved even when their wording differs", async () => {
  await publish("kam", [row("a"), row("b", name + " new")]);
  await publish("spar", [row("a")]);
  await match();
  expect(
    (await pool.query("SELECT DISTINCT group_id FROM store_products")).rowCount,
  ).toBe(3);
});
it("the first campaign is resumable and automatic matching is off by default", async () => {
  await publish("kam", [row("a")]);
  expect(await repo.startPending(null)).toBeNull();
  await repo.backfillStoreProducts();
  const campaign = await repo.ensureCampaign("initial");
  expect((await repo.ensureCampaign("initial")).id).toBe(campaign.id);
  await repo.pauseCampaign(campaign.id, "Paused by you");
  expect((await repo.controlCampaign("resume", null))[0].state).toBe("running");
});
it("matching continuation runs retain their initial campaign and its shared allowance", async () => {
  const campaign = await repo.ensureCampaign("initial");
  const run = await createRun("match", null, null, null);
  await pool.query(
    `UPDATE runs SET checkpoint=jsonb_build_object('campaign_id',$2::text) WHERE id=$1`,
    [run.id, campaign.id],
  );
  const continuation = await createRun("match", null, null, run.id);
  expect((await repo.campaignForRun(continuation.id, null)).id).toBe(
    campaign.id,
  );
  expect(
    (
      await pool.query(
        `SELECT * FROM matching_campaigns WHERE kind='incremental'`,
      )
    ).rowCount,
  ).toBe(0);
});
it("distinguishes diaper suitability, count and size from package weight", () => {
  const p = prepared("BABYLINO SENSITIVE SIZE 6 13-18KG 38/1");
  expect(p.family).toBe("baby_care");
  expect(p.facts.quantity).toBeUndefined();
  expect(p.facts.pack?.value).toBe("38");
  expect(p.facts.size?.value).toBe("6");
  expect(
    differences(p, prepared("BABYLINO SENSITIVE SIZE 6 13-18KG 40/1", "spar")),
  ).toContain("pack: 38 versus 40");
});
it("requires stated variety and sale unit for loose produce", () => {
  const a = prepared("КРУША /кгр сорта: ВИЛЈАМОВКА");
  const b = prepared("КРУША /кгр сорта: ВИЛЈАМОВКА", "spar");
  expect(enoughEvidence(a, b)).toBe(true);
  expect(enoughEvidence(a, prepared("КРУША /кгр", "spar"))).toBe(false);
});
it("missing chocolate flavour is unknown, not a proven difference", () => {
  const a = prepared("ДОРИНА ЧОКОЛАДО 80ГР"),
    b = prepared("ДОРИНА ЛЕШНИК 80ГР", "spar");
  expect(differences(a, b)).toEqual([]);
  expect(enoughEvidence(a, b)).toBe(false);
});
it("checks every member rather than following pairwise connections blindly", () => {
  const a = prepared(name),
    b = prepared(name, "spar"),
    c = prepared("Coca-Cola Zero 6 x 330 ml cans", "vero");
  expect(groupProblem([a, b, c])).toContain("variant");
});
function response(answers: Record<string, unknown>, cost = "0.00001") {
  return Response.json({
    answers,
    usage: { inputTokens: 500, outputTokens: 0 },
    providerMetadata: { gateway: { cost, generationId: "gen_test" } },
  });
}
it("native decisions allow several independent same answers and retain separate confidence metrics", async () => {
  settings.matching.gateway.enabled = true;
  settings.matching.gateway.api_key = "test-key";
  const campaign = await repo.ensureCampaign("evaluation");
  await publish("kam", [row("gateway-query")]);
  await publish("spar", [row("gateway-candidate")]);
  await publish("vero", [row("gateway-candidate")]);
  const products = (await pool.query("SELECT id,retailer FROM store_products"))
    .rows;
  const a = await repo.getProduct(
      products.find((p) => p.retailer === "kam").id,
    ),
    b = await repo.getProduct(products.find((p) => p.retailer === "spar").id),
    c = await repo.getProduct(products.find((p) => p.retailer === "vero").id);
  const candidates = [b, c].map((product) => ({
    product,
    members: [product],
    group_version: 0,
    reasons: ["Name"],
    score: 1,
  }));
  const answer = {
    type: "choice",
    choice: "same",
    probabilities: { same: 0.999, different: 0.0005, insufficient: 0.0005 },
    confidence: 0.91,
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValue(response({ candidate_0: answer, candidate_1: answer }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await compare(campaign, a, candidates);
  expect(result.map((x) => x.answer.choice)).toEqual(["same", "same"]);
  expect(result[0].answer.probabilities.same).toBe(0.999);
  expect(result[0].answer.confidence).toBe(0.91);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(Object.keys(body.questions)).toHaveLength(2);
  expect(Object.keys(body.state.products)).toHaveLength(3);
  expect(body.state.query).toBe(a.id);
  expect(body.state.candidates.candidate_0.members).toEqual([b.id]);
  expect(body.state.candidates.candidate_1.members).toEqual([c.id]);
  expect(
    (await pool.query("SELECT cost_usd FROM ai_usage")).rows[0].cost_usd,
  ).toBe("0.000010000000");
  await compare(campaign, a, candidates);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("enforces the initial allowance across batches and does not apply the incremental cap to it", async () => {
  settings.matching.gateway.enabled = true;
  settings.matching.gateway.api_key = "test-key";
  settings.matching.gateway.initial_budget_usd = 0.01;
  settings.matching.gateway.monthly_budget_usd = 0;
  const campaign = await repo.ensureCampaign("initial");
  const answer = { type: "choice", choice: "same", probabilities: { same: 1 } };
  const mock = vi.fn().mockResolvedValue(response({ x: answer }, "0.01"));
  vi.stubGlobal("fetch", mock);
  const question = {
    x: {
      type: "choice" as const,
      instructions: "Test",
      criteria: { same: "Same" },
    },
  };
  await decide(campaign, "first", question);
  await expect(decide(campaign, "second", question)).rejects.toThrow(
    "spending",
  );
  expect(mock).toHaveBeenCalledTimes(1);
});
it("keeps uncertain transport reservations and never silently repeats an identical paid call", async () => {
  settings.matching.gateway.enabled = true;
  settings.matching.gateway.api_key = "test-key";
  const campaign = await repo.ensureCampaign("evaluation");
  const mock = vi.fn().mockRejectedValue(new Error("timeout"));
  vi.stubGlobal("fetch", mock);
  const q = {
    x: {
      type: "choice" as const,
      instructions: "Test",
      criteria: { same: "Same" },
    },
  };
  await expect(decide(campaign, "same input", q)).rejects.toThrow(
    "reservation retained",
  );
  await expect(decide(campaign, "same input", q)).rejects.toThrow(
    "reconciliation",
  );
  expect(mock).toHaveBeenCalledTimes(1);
});
it("rejects a clarification with altered source quotes", async () => {
  settings.matching.gateway.enabled = true;
  settings.matching.gateway.api_key = "test-key";
  const campaign = await repo.ensureCampaign("evaluation");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                facts: [
                  {
                    field: "brand",
                    value: "invented",
                    quote: "not in source",
                    source: "name",
                  },
                ],
                missing: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 30, cost: 0.00001 },
        id: "gen_test",
      }),
    ),
  );
  await publish("kam", [row("clarification")]);
  const product = await repo.getProduct(
    (await pool.query("SELECT id FROM store_products WHERE retailer='kam'"))
      .rows[0].id,
  );
  await expect(clarify(campaign, product, ["brand"])).rejects.toThrow(
    "unsupported evidence",
  );
});
it("flags conflicting branch descriptions and queues a recheck when the branches agree again", async () => {
  await publish("kam", [row("cola")]);
  await publish("kam", [row("cola")], "two");
  await publish("kam", [row("cola", "Coca-Cola Original 6 x 500 ml cans")]);
  expect(
    (await pool.query(`SELECT * FROM store_products WHERE branch_conflict`))
      .rowCount,
  ).toBe(2);
  await publish(
    "kam",
    [row("cola", "Coca-Cola Original 6 x 500 ml cans")],
    "two",
  );
  expect(
    (await pool.query(`SELECT * FROM store_products WHERE branch_conflict`))
      .rowCount,
  ).toBe(0);
  expect(
    (await pool.query(`SELECT * FROM matching_work WHERE state='pending'`))
      .rowCount,
  ).toBeGreaterThan(0);
});
it("claims distinct work concurrently and recovers expired claims without accepting an old worker", async () => {
  await publish("kam", [row("a")]);
  await publish("spar", [row("a")]);
  const run = await createRun("match", null, null, null),
    campaign = await repo.campaignForRun(run.id, null);
  settings.matching.batch_size = 1;
  const [one, two] = await Promise.all([
    repo.claimWork(campaign.id),
    repo.claimWork(campaign.id),
  ]);
  expect(one).toHaveLength(1);
  expect(two).toHaveLength(1);
  expect(one[0].id).not.toBe(two[0].id);
  await pool.query(
    `UPDATE matching_work SET lease_until=now()-interval '1 second' WHERE id=$1`,
    [one[0].id],
  );
  const recovered = await repo.claimWork(campaign.id);
  expect(recovered[0].id).toBe(one[0].id);
  expect(recovered[0].token).not.toBe(one[0].token);
  const query = await repo.getProduct(one[0].store_product_id),
    candidates = await repo.findCandidates(query);
  const result = await repo.recordResult(
    query,
    one[0],
    candidates.map((candidate) => ({
      candidate,
      outcome: "matched",
      reason: "Test exact signature",
      method: "rules",
      probability: 1,
      confidence: null,
    })),
    "old-worker",
    "No candidate",
  );
  expect(result).toEqual({ matched: false, stale: true });
  expect(
    (
      await pool.query(
        `SELECT count(DISTINCT group_id)::int AS n FROM store_products`,
      )
    ).rows[0].n,
  ).toBe(2);
});
it("records a stale answer without joining a changed product", async () => {
  await publish("kam", [row("a")]);
  await publish("spar", [row("a")]);
  const run = await createRun("match", null, null, null),
    campaign = await repo.campaignForRun(run.id, null);
  const work = (await repo.claimWork(campaign.id))[0],
    query = await repo.getProduct(work.store_product_id),
    candidates = await repo.findCandidates(query);
  await repo.saveFacts(
    query,
    {
      ...query.facts,
      variant: {
        value: "zero",
        quote: query.name,
        source: "name",
        method: "rule",
      },
    },
    query.family,
    [],
  );
  const result = await repo.recordResult(
    query,
    work,
    candidates.map((candidate) => ({
      candidate,
      outcome: "matched",
      reason: "Answer obtained before source revision",
      method: "decision",
      probability: 1,
      confidence: 0.99,
    })),
    "stale-request",
    "No candidate",
  );
  expect(result).toEqual({ matched: false, stale: true });
  expect(
    (
      await pool.query(
        `SELECT * FROM store_match_decisions WHERE outcome='stale'`,
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (await pool.query(`SELECT state FROM matching_work WHERE id=$1`, [work.id]))
      .rows[0].state,
  ).toBe("pending");
});
it("backfills in bounded restartable chunks while preserving original IDs and offers", async () => {
  await publish("kam", [row("a"), row("b", "Pepsi Original 500 ml can")]);
  await publish(
    "kam",
    [row("a"), row("b", "Pepsi Original 500 ml can")],
    "two",
  );
  const originalRows = (
    await pool.query("SELECT id,product_id FROM listings ORDER BY id")
  ).rows;
  await pool.query("TRUNCATE store_products CASCADE");
  settings.matching.backfill_batch_size = 1;
  let batches = 0;
  while (!(await repo.backfillStoreProducts()).completed && batches++ < 10) {}
  expect(batches).toBe(4);
  expect(
    (await pool.query("SELECT id,product_id FROM listings ORDER BY id")).rows,
  ).toEqual(originalRows);
  expect((await pool.query("SELECT * FROM store_products")).rowCount).toBe(2);
  expect(
    (await pool.query("SELECT * FROM store_product_aliases")).rowCount,
  ).toBe(4);
  expect((await pool.query("SELECT * FROM offers")).rowCount).toBe(4);
  expect(await repo.backfillStoreProducts()).toEqual({
    processed: 0,
    completed: true,
  });
});
it("preserves accepted legacy groups, redirects, branch prices and decision history during migration", async () => {
  await publish("kam", [row("cola")]);
  await publish("kam", [row("cola")], "two");
  await publish("spar", [row("cola")]);
  const rows = (await pool.query("SELECT * FROM listings ORDER BY retailer,id"))
    .rows;
  const root = rows[0].product_id,
    redirect = rows[2].product_id;
  await pool.query("TRUNCATE store_products CASCADE");
  await pool.query(`UPDATE listings SET product_id=$1,match_status='matched'`, [
    root,
  ]);
  await pool.query(`UPDATE products SET redirect_id=$2 WHERE id=$1`, [
    redirect,
    root,
  ]);
  await pool.query(
    `UPDATE listings SET product_id=$2,match_status='separate' WHERE id=$1`,
    [rows[1].id, rows[1].product_id],
  );
  for (const listing of [rows[0], rows[2]])
    await pool.query(
      `INSERT INTO match_decisions(listing_id,identity_hash,product_id,method,probability,evidence,prompt_version) VALUES($1,$2,$3,'local-rules',1,'{}','legacy')`,
      [listing.id, listing.identity_hash, root],
    );
  const mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  expect((await repo.backfillStoreProducts()).completed).toBe(true);
  expect(
    (await pool.query(`SELECT group_id,state FROM store_products`)).rows,
  ).toEqual([
    { group_id: root, state: "matched" },
    { group_id: root, state: "matched" },
  ]);
  expect(await offersForProduct(redirect)).toHaveLength(3);
  const details = await detailsForProduct(redirect);
  expect(details?.product.id).toBe(root);
  expect(details?.decisions).toHaveLength(2);
  expect(
    (await pool.query("SELECT id FROM listings ORDER BY retailer,id")).rows.map(
      (r) => r.id,
    ),
  ).toEqual(rows.map((r) => r.id));
  expect(mock).not.toHaveBeenCalled();
});
it("saves an old legacy revision before an import changes it during backfill", async () => {
  await publish("kam", [row("cola")]);
  const old = (await pool.query("SELECT * FROM listings")).rows[0];
  await pool.query("TRUNCATE store_products CASCADE");
  await pool.query(`UPDATE listings SET match_status='matched' WHERE id=$1`, [
    old.id,
  ]);
  await publish("kam", [row("cola", "Coca-Cola Original 6 x 500 ml cans")]);
  const saved = (
    await pool.query(`SELECT * FROM store_products WHERE name=$1`, [name])
  ).rows[0];
  expect(saved).toMatchObject({ group_id: old.product_id, state: "matched" });
  expect((await pool.query(`SELECT * FROM store_products`)).rowCount).toBe(2);
  await publish("kam", [row("cola")]);
  expect(
    (
      await pool.query(
        `SELECT sp.id,sp.group_id FROM store_product_sources ss JOIN store_products sp ON sp.id=ss.store_product_id`,
      )
    ).rows[0],
  ).toEqual({ id: saved.id, group_id: old.product_id });
});
it("uses category as a search hint rather than rejecting supported barcode identity", () => {
  const a = prepared(name),
    b = { ...prepared(name, "spar"), family: "other_food" as const };
  expect(differences(a, b)).toEqual([]);
  expect(enoughEvidence(a, b)).toBe(true);
});
it("does not extract zero quantities or empty packs as identity proof", () => {
  expect(
    prepared("Coca-Cola Original 0 ml can").facts.quantity,
  ).toBeUndefined();
  expect(prepared("BABYLINO SENSITIVE SIZE 6 0/1").facts.pack).toBeUndefined();
});
it("keeps complete clothing model suffixes and ignores code casing", () => {
  const first = prepared("MAICA C9834 CB12-41");
  expect(first.facts.model?.value).toBe("C9834 CB12-41");
  expect(prepared("MAICA c9834 cb12-41").facts.model?.value).toBe(
    first.facts.model?.value,
  );
  expect(
    differences(first, prepared("MAICA C9834 CB12-42", "spar")).some((d) =>
      d.startsWith("model:"),
    ),
  ).toBe(true);
});
it("keeps saved product facts and connections readable after every offer disappears", async () => {
  await publish("kam", [row("cola")]);
  await publish("spar", [row("cola")]);
  await match();
  const saved = (
    await pool.query(`SELECT * FROM store_products WHERE retailer='kam'`)
  ).rows[0];
  await publish("kam", [row("other", "Pepsi Original 500 ml can")]);
  await publish("spar", [row("other", "Pepsi Original 500 ml can")]);
  const details = await detailsForProduct(saved.group_id);
  expect(details?.offers).toHaveLength(0);
  expect(details?.listings).toHaveLength(2);
  expect(details?.listings.every((p) => Number(p.catalog_count) === 0)).toBe(
    true,
  );
  expect(details?.listings[0].supported_facts).toMatchObject({
    brand: { value: "coca-cola" },
    quantity: { value: "330" },
  });
  expect(details?.decisions.length).toBeGreaterThan(0);
});
it("a conflicting stated produce origin prevents a loose-produce connection", () => {
  const a = prepared("КРУША /кгр сорта: ВИЛЈАМОВКА; потекло: Македонија");
  const b = prepared("КРУША /кгр сорта: ВИЛЈАМОВКА; потекло: Србија", "spar");
  expect(differences(a, b).some((reason) => reason.startsWith("origin:"))).toBe(
    true,
  );
  expect(enoughEvidence(a, b)).toBe(false);
});
it("invalid provider answers become remembered uncertainty without endlessly queuing empty campaigns", async () => {
  await publish("kam", [row("cola", "Coca-Cola Original 330 ml can")]);
  await publish("spar", [row("cola", "Coca-Cola Original 330 ml can new")]);
  settings.matching.gateway.enabled = true;
  settings.matching.gateway.api_key = "test-key";
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(response({ candidate_0: { type: "refusal" } })),
      ),
  );
  await match();
  await match();
  await match();
  expect(
    (await pool.query(`SELECT * FROM matching_work WHERE state<>'completed'`))
      .rowCount,
  ).toBe(0);
  expect(
    (await pool.query(`SELECT * FROM matching_campaigns WHERE state='running'`))
      .rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query(
        `SELECT count(DISTINCT group_id)::int AS n FROM store_products`,
      )
    ).rows[0].n,
  ).toBe(2);
});
it.each([
  {
    label: "count embedded in another number",
    name: "BABYLINO SENSITIVE SIZE 6 13-18KG 12/1",
    fields: ["pack"],
    facts: [{ field: "pack", value: "2", quote: "12/1", source: "name" }],
  },
  {
    label: "invented model value",
    name: "MAICA C9834",
    fields: ["model"],
    facts: [{ field: "model", value: "C9835", quote: "C9834", source: "name" }],
  },
  {
    label: "quantity paired with a different unit",
    name: "Coca-Cola Original 330 ml can",
    fields: ["quantity", "unit"],
    facts: [
      { field: "quantity", value: "330", quote: "330 ml", source: "name" },
      { field: "unit", value: "l", quote: "Cola", source: "name" },
    ],
  },
])(
  "rejects unsupported clarification: $label",
  async ({ name, fields, facts }) => {
    settings.matching.gateway.enabled = true;
    settings.matching.gateway.api_key = "test-key";
    const campaign = await repo.ensureCampaign("evaluation");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [
            { message: { content: JSON.stringify({ facts, missing: [] }) } },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 30, cost: 0.00001 },
          id: "gen_test",
        }),
      ),
    );
    await expect(clarify(campaign, prepared(name), fields)).rejects.toThrow();
  },
);
