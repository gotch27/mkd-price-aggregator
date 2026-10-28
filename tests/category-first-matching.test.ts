import {
  requeueUnclassifiedProducts,
  requeueSelectedCategories,
} from "@/tests/helpers/matching";
import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import { matchBatch } from "@/tests/helpers/matching";
import * as repository from "@/nextsignal/services/matching-repository";
import { search, save } from "@/nextsignal/services/manual-matching";
import { families, type Family } from "@/nextsignal/domain/matching";
import type { CatalogRow, Retailer } from "@/nextsignal/domain/types";
const original = structuredClone(settings.matching);
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated test database required");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.assign(settings.matching, structuredClone(original));
  Object.assign(settings.matching.gateway, {
    enabled: true,
    api_key: "test-key",
  });
  settings.matching.ai_categories = [];
  await pool.query(
    "TRUNCATE retailers,products,runs,sources,listings,ai_cache CASCADE",
  );
  await seedRetailers();
});
afterAll(async () => {
  Object.assign(settings.matching, original);
  vi.unstubAllGlobals();
  await pool.end();
});
async function publish(
  retailer: Retailer,
  name: string,
  branch = "one",
  price = "50.00",
  gtin: string | null = null,
) {
  const source = (
    await pool.query(
      `INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,$2,$3,'branch','{}') ON CONFLICT(retailer,external_id) DO UPDATE SET active=true RETURNING id`,
      [retailer, branch, settings.sources[retailer].url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", retailer, source, null);
  const row: CatalogRow = {
    key: "item",
    name,
    description: null,
    category: null,
    gtin,
    price,
    regular_price: null,
    promo_price: null,
    unit_price: null,
    available: true,
    promotion: null,
    source_updated_at: null,
    raw: {},
  };
  await stagePage(run, { rows: [row], next: null, total: 1, artifact: null });
  await publishCatalog(await getRun(run.id));
}
function provider(
  categories: Partial<Record<Retailer, Family>> = {},
  same = 0.8,
) {
  const calls: {
    classification: number;
    comparison: number;
    clarification: number;
  } = { classification: 0, comparison: 0, clarification: 0 };
  const fetch = vi.fn().mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (!body.questions) {
      calls.clarification++;
      throw new Error("Unexpected Qwen call");
    }
    let answers: Record<string, unknown>;
    if (body.questions.family) {
      calls.classification++;
      const selected =
        categories[body.state.product.store as Retailer] ?? "soft_drinks";
      answers = {
        family: {
          type: "choice",
          choice: selected,
          probabilities: Object.fromEntries(
            families.map((f) => [f, f === selected ? 1 : 0]),
          ),
          confidence: 0.9,
        },
      };
    } else {
      calls.comparison++;
      answers = Object.fromEntries(
        Object.keys(body.questions).map((k) => [
          k,
          {
            type: "choice",
            choice: "same",
            probabilities: {
              same,
              different: (1 - same) / 2,
              insufficient: (1 - same) / 2,
            },
            confidence: 0.1,
          },
        ]),
      );
    }
    return Response.json({
      answers,
      usage: { inputTokens: 100, outputTokens: 0 },
      providerMetadata: {
        gateway: {
          cost: "0.000002",
          generationId: `mock_${fetch.mock.calls.length}`,
        },
      },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}
async function run() {
  const job = await createRun("match", null, null, null);
  let result = await matchBatch(job.id, null);
  let n = 0;
  while (result.more && n++ < 12) result = await matchBatch(job.id, null);
  expect(n).toBeLessThan(12);
}
const a = "Coca-Cola Original 330 ml can label A",
  b = "Coca-Cola Original 330 ml can label B";
it("categorizes clear products once per chain, reuses branch/price updates, and code-matches excluded labels", async () => {
  const mock = provider();
  await publish("kam", "Coca-Cola Original 330 ml can");
  await publish("kam", "Coca-Cola Original 330 ml can", "two");
  await publish("spar", "Coca-Cola Original 330 ml can");
  await run();
  expect(mock.calls).toEqual({
    classification: 2,
    comparison: 0,
    clarification: 0,
  });
  expect(
    (await pool.query("SELECT DISTINCT group_id FROM store_products")).rowCount,
  ).toBe(1);
  expect(
    (await pool.query("SELECT * FROM store_product_classifications")).rowCount,
  ).toBe(2);
  await publish("kam", "COCA-COLA ORIGINAL 330 ml CAN", "one", "42.00");
  await run();
  expect(mock.calls.classification).toBe(2);
  expect(
    (await pool.query("SELECT * FROM store_product_classifications")).rowCount,
  ).toBe(2);
});
it("leaves excluded products unmatched without claiming they differ or calling comparison/Qwen", async () => {
  const mock = provider({ kam: "household", spar: "household" });
  await publish("kam", "Chair C9834");
  await publish("spar", "Chair C9834 blue");
  await run();
  expect(mock.calls).toEqual({
    classification: 2,
    comparison: 0,
    clarification: 0,
  });
  expect((await pool.query("SELECT state FROM store_products")).rows).toEqual([
    { state: "category_excluded" },
    { state: "category_excluded" },
  ]);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM store_match_decisions WHERE outcome='different'",
      )
    ).rowCount,
  ).toBe(0);
});
it("keeps unknown products outside paid comparison and preserves their category decisions", async () => {
  settings.matching.ai_categories = ["soft_drinks"];
  const mock = provider({ kam: "unknown", spar: "unknown" });
  await publish("kam", a);
  await publish("spar", b);
  await run();
  expect(mock.calls).toEqual({
    classification: 2,
    comparison: 0,
    clarification: 0,
  });
  expect(
    (await pool.query("SELECT classified_family,state FROM store_products"))
      .rows,
  ).toEqual([
    { classified_family: "unknown", state: "category_excluded" },
    { classified_family: "unknown", state: "category_excluded" },
  ]);
  expect(
    (await pool.query("SELECT * FROM store_product_classifications")).rowCount,
  ).toBe(2);
});
it("rechecks category permission when committing an AI proposal", async () => {
  const mock = provider();
  await publish("kam", a);
  await publish("spar", b);
  await run();
  const campaign = await repository.ensureCampaign("evaluation");
  await pool.query("UPDATE matching_work SET state='pending',campaign_id=$1", [
    campaign.id,
  ]);
  const [work] = await repository.claimWork(campaign.id);
  const query = await repository.getProduct(work.store_product_id);
  const [candidate] = await repository.findCandidates(query);
  const result = await repository.recordResult(
    query,
    work,
    [
      {
        candidate,
        method: "decision",
        outcome: "matched",
        reason: "Simulated answer after the category was excluded",
        probability: 0.9,
        confidence: 0.9,
      },
    ],
    "test-category-commit",
    "Not enough product information",
  );
  expect(result).toEqual({ matched: false, stale: false });
  expect(
    (await pool.query("SELECT DISTINCT group_id FROM store_products")).rowCount,
  ).toBe(2);
  expect(mock.calls.comparison).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT reason FROM store_match_decisions ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0].reason,
  ).toContain("not selected for AI matching");
});
it("categorizes previously completed manual products in bounded chunks without losing their connection", async () => {
  const mock = provider();
  await publish("kam", a);
  await publish("spar", b);
  const products = (
    await pool.query("SELECT id,group_id FROM store_products ORDER BY retailer")
  ).rows;
  const first = (await search(products[0].group_id, "", 1)).group!;
  const second = (await search(products[1].group_id, "", 1)).group!;
  expect(
    await save(
      {
        id: first.id,
        action: "connect",
        snapshot: first.snapshot,
        candidate_id: second.id,
        candidate_snapshot: second.snapshot,
        note: "Verified by the owner before categorization",
      },
      "test-admin",
    ),
  ).toEqual({ ok: true, product_id: first.id });
  expect(
    (await pool.query("SELECT 1 FROM matching_work WHERE state='pending'"))
      .rowCount,
  ).toBe(0);
  const size = settings.maintenance.batch_size;
  settings.maintenance.batch_size = 1;
  expect(await requeueUnclassifiedProducts(null)).toBe(1);
  expect(await requeueUnclassifiedProducts(null)).toBe(1);
  expect(await requeueUnclassifiedProducts(null)).toBe(0);
  settings.maintenance.batch_size = size;
  await run();
  expect(mock.calls).toEqual({
    classification: 2,
    comparison: 0,
    clarification: 0,
  });
  expect(
    (await pool.query("SELECT DISTINCT group_id,state FROM store_products"))
      .rows,
  ).toEqual([{ group_id: first.id, state: "matched" }]);
  expect(
    (await pool.query("SELECT 1 FROM manual_product_links WHERE action='same'"))
      .rowCount,
  ).toBe(1);
  expect(await requeueUnclassifiedProducts(null)).toBe(0);
});
it("allows a validated conflict-free barcode match in an excluded category", async () => {
  const mock = provider({ kam: "household", spar: "household" });
  await publish("kam", "Chair C9834", "one", "50.00", "4006381333931");
  await publish("spar", "Chair C9834 chair", "one", "55.00", "4006381333931");
  await run();
  expect(
    (await pool.query("SELECT DISTINCT group_id FROM store_products")).rowCount,
  ).toBe(1);
  expect(mock.calls.comparison).toBe(0);
});
it("does not automatically repeat an invalid first-category answer", async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      answers: {
        family: {
          type: "choice",
          choice: "soft_drinks",
          probabilities: { soft_drinks: 0.4 },
        },
      },
      usage: { inputTokens: 10, outputTokens: 0 },
      providerMetadata: {
        gateway: { cost: "0.000001", generationId: "mock_invalid_category" },
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await publish("kam", a);
  await run();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    (
      await pool.query(
        "SELECT state,classification_key,classification_attempt_key FROM store_products",
      )
    ).rows[0],
  ).toEqual({
    state: "needs_info",
    classification_key: null,
    classification_attempt_key: expect.any(String),
  });
  expect(await requeueUnclassifiedProducts(null)).toBe(0);
});
it("enabling a category queues bounded work and reuses saved classifications", async () => {
  const mock = provider();
  await publish("kam", a);
  await publish("spar", b);
  await run();
  expect(mock.calls.comparison).toBe(0);
  settings.matching.ai_categories = ["soft_drinks"];
  const size = settings.maintenance.batch_size;
  settings.maintenance.batch_size = 1;
  expect(await requeueSelectedCategories(null)).toBe(1);
  settings.maintenance.batch_size = size;
  await requeueSelectedCategories(null);
  await run();
  expect(mock.calls.classification).toBe(2);
  expect(mock.calls.comparison).toBeGreaterThan(0);
  expect(
    (await pool.query("SELECT DISTINCT group_id FROM store_products")).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM store_match_decisions WHERE probability=0.8 AND confidence=0.1 AND prompt_key IS NOT NULL",
      )
    ).rowCount,
  ).toBeGreaterThan(0);
});
it.each([0.74, 0.75])(
  "uses same-product probability %s rather than the separate confidence field",
  async (probability) => {
    settings.matching.ai_categories = ["soft_drinks"];
    const mock = provider({}, probability);
    await publish("kam", a);
    await publish("spar", b);
    await run();
    expect(mock.calls.comparison).toBeGreaterThan(0);
    expect(
      (await pool.query("SELECT DISTINCT group_id FROM store_products"))
        .rowCount,
    ).toBe(probability >= 0.75 ? 1 : 2);
  },
);
it("does not pay to compare an excluded counterpart even when the query category is selected", async () => {
  settings.matching.ai_categories = ["soft_drinks"];
  const mock = provider({ kam: "soft_drinks", spar: "household" });
  await publish("kam", a);
  await publish("spar", b);
  await run();
  expect(mock.calls.classification).toBe(2);
  expect(mock.calls.comparison).toBe(0);
  expect(
    (await pool.query("SELECT DISTINCT group_id FROM store_products")).rowCount,
  ).toBe(2);
});
it("keeps hard size conflicts separate at the lower matching cutoff", async () => {
  settings.matching.ai_categories = ["soft_drinks"];
  const mock = provider({}, 0.99);
  await publish("kam", a);
  await publish("spar", b.replace("330", "500"));
  await run();
  expect(mock.calls.comparison).toBe(0);
  expect(
    (await pool.query("SELECT DISTINCT group_id FROM store_products")).rowCount,
  ).toBe(2);
});
