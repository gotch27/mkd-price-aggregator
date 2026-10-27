import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import {
  getProduct,
  saveClassification,
} from "@/nextsignal/services/matching-repository";
import { classificationRequest } from "@/nextsignal/services/ai-gateway";
import { readQueue } from "@/nextsignal/services/category-review";
import {
  readCategory,
  saveCategory,
} from "@/nextsignal/services/product-categories";
import { readSettings } from "@/nextsignal/services/task-settings";
import type { CategoryReviewQuery } from "@/nextsignal/domain/category-review";
import type { Retailer } from "@/nextsignal/domain/types";

beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  vi.restoreAllMocks();
  await pool.query(
    "TRUNCATE retailers,products,runs,sources,listings,ai_cache,ai_usage,operational_settings,operational_settings_history,task_executions CASCADE",
  );
  await seedRetailers();
  await readSettings();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Manual review must not call providers");
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.end();
});
const query: CategoryReviewQuery = {
  status: "needs_review",
  search: "",
  availability: "available",
  page: 1,
  size: 10,
};
async function product(
  name: string,
  retailer: Retailer = "kam",
  branch = "one",
  available: boolean | null = true,
) {
  const source = (
    await pool.query(
      `INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,$2,$3,'branch','{}')
    ON CONFLICT(retailer,external_id) DO UPDATE SET active=true RETURNING id`,
      [retailer, branch, settings.sources[retailer].url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", retailer, source, null);
  await stagePage(run, {
    rows: [
      {
        key: "one",
        name,
        description: null,
        category: null,
        gtin: null,
        price: "40.00",
        regular_price: null,
        promo_price: null,
        unit_price: null,
        available,
        promotion: null,
        source_updated_at: null,
        raw: {},
      },
    ],
    next: null,
    total: 1,
    artifact: null,
  });
  await publishCatalog(await getRun(run.id));
  return getProduct(
    (
      await pool.query(
        "SELECT store_product_id FROM store_product_aliases WHERE source_id=$1",
        [source],
      )
    ).rows[0].store_product_id,
  );
}
async function classify(
  id: string,
  assigned = false,
  selected = "soft_drinks",
) {
  const p = await getProduct(id);
  await pool.query(
    "INSERT INTO matching_prompt_versions(key,files) VALUES('review-test','[]') ON CONFLICT DO NOTHING",
  );
  await saveClassification(p, {
    key: classificationRequest(p).key,
    family: assigned ? "soft_drinks" : "unknown",
    hints: [],
    model: "mock",
    prompt_key: "review-test",
    selected,
    probabilities: {
      [selected]: assigned ? 0.9 : 0.7,
      other_food: assigned ? 0.1 : 0.3,
    },
    confidence: 0.99,
    generation_id: "mock",
  });
}

it("lists one product per chain, with saved scores and no provider or task activity", async () => {
  const cola = await product("Coca-Cola Original 330 ml can");
  await product(cola.name, "kam", "two");
  await classify(cola.id);
  await product("Uncategorized product", "vero");
  const before = (
    await pool.query("SELECT count(*)::int n FROM product_category_edits")
  ).rows[0].n;
  const result = await readQueue(query);
  expect(result.counts).toEqual({
    total: 1,
    needs_review: 1,
    assigned: 0,
    reviewed: 0,
    agent: 0,
  });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].classification.options.slice(0, 2)).toMatchObject([
    { category: "soft_drinks", probability: 0.7 },
    { category: "other_food", probability: 0.3 },
  ]);
  expect(result.rows[0]).toMatchObject({
    id: cola.id,
    product_id: cola.group_id,
    availability: "available",
    classification: {
      state: "uncertain",
      probability: 0.7,
      can_accept_suggestion: true,
    },
  });
  expect(
    (await pool.query("SELECT count(*)::int n FROM product_category_edits"))
      .rows[0].n,
  ).toBe(before);
  expect((await pool.query("SELECT * FROM task_executions")).rowCount).toBe(0);
  expect((await pool.query("SELECT * FROM ai_usage")).rowCount).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("filters saved classifications by review state and advances after acceptance", async () => {
  const pending = await product("Coca-Cola Original 330 ml can"),
    assigned = await product("Pepsi Original 330 ml can", "vero");
  await classify(pending.id);
  await classify(assigned.id, true);
  const first = await readQueue(query);
  const item = first.rows[0];
  const saved = await saveCategory(
    {
      id: item.product_id,
      member_id: item.id,
      snapshot: item.classification.snapshot,
      action: "accept_suggestion",
      category: null,
      note: "",
    },
    "reviewer",
  );
  expect(saved.ok).toBe(true);
  const after = await readQueue(query);
  expect(after.rows).toHaveLength(0);
  expect(after.counts).toEqual({
    total: 2,
    needs_review: 0,
    assigned: 1,
    reviewed: 1,
    agent: 0,
  });
  expect(
    (await readQueue({ ...query, status: "assigned" })).rows.map((r) => r.id),
  ).toEqual([assigned.id]);
  expect(
    (await readQueue({ ...query, status: "reviewed" })).rows[0],
  ).toMatchObject({
    id: pending.id,
    classification: { state: "manual", category: "soft_drinks" },
  });
  expect((await readQueue({ ...query, status: "all" })).rows).toHaveLength(2);
  expect(fetch).not.toHaveBeenCalled();
});

it("excludes unavailable and inactive catalogs by default, and never loses saved classifications", async () => {
  const available = await product("Coca Cola 330 ml"),
    unavailable = await product("Pepsi 330 ml", "vero", "one", false),
    inactive = await product("Fanta 330 ml", "spar");
  for (const p of [available, unavailable, inactive]) await classify(p.id);
  await pool.query("UPDATE sources SET active=false WHERE retailer='spar'");
  expect((await readQueue(query)).rows.map((r) => r.id)).toEqual([
    available.id,
  ]);
  const all = await readQueue({ ...query, availability: "all" });
  expect(all.rows).toHaveLength(2);
  expect(all.rows.find((r) => r.id === unavailable.id)?.availability).toBe(
    "unavailable",
  );
  expect(
    (await pool.query("SELECT * FROM store_product_classifications")).rowCount,
  ).toBe(3);
});

it("supports store, readable name search and bounded pagination with stable scores", async () => {
  const names = [
    "2010 DETSKI SET ^E[EL I ^ETKA",
    "PEPSI 330ML",
    "COCA COLA 330ML",
  ];
  for (let i = 0; i < names.length; i++) {
    const p = await product(names[i], "spar", String(i));
    await classify(p.id);
  }
  const first = await readQueue({ ...query, size: 1 });
  const second = await readQueue({ ...query, page: 2, size: 1 });
  expect(first.total_pages).toBe(3);
  expect(first.rows[0].id).not.toBe(second.rows[0].id);
  expect((await readQueue({ ...query, page: 99, size: 1 })).page).toBe(3);
  expect((await readQueue({ ...query, retailer: "kam" })).total).toBe(0);
  const found = await readQueue({
    ...query,
    retailer: "spar",
    search: "чешел",
  });
  expect(found.total).toBe(1);
  expect(found.rows[0].name).toBe(names[0]);
  expect((await readQueue({ ...query, search: "%" })).total).toBe(0);
});

it("includes manual categories without AI results and keeps original probabilities after correction", async () => {
  const p = await product("Coca Cola Original 330 ml can");
  const before = (await readCategory(p.group_id, p.id))!;
  await saveCategory(
    {
      id: p.group_id,
      member_id: p.id,
      snapshot: before.classification.snapshot,
      action: "set",
      category: "soft_drinks",
      note: "",
    },
    "reviewer",
  );
  const result = await readQueue({ ...query, status: "reviewed" });
  expect(
    result.rows[0].classification.options.every((o) => o.probability === null),
  ).toBe(true);
  expect(result.rows[0].classification).toMatchObject({
    category: "soft_drinks",
    can_accept_suggestion: false,
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("protects the read endpoint and validates scope without making external requests", async () => {
  const { GET } = await import("@/app/api/review/categories/route");
  const { SESSION_COOKIE, sessionToken } =
    await import("@/nextsignal/adapters/auth");
  const url = new URL(
    "/api/review/categories",
    settings.auth.allowed_origins[0],
  );
  url.search = new URLSearchParams({
    ...query,
    page: "1",
    size: "10",
  }).toString();
  expect((await GET(new Request(url))).status).toBe(401);
  const headers = { cookie: `${SESSION_COOKIE}=${sessionToken()}` };
  expect((await GET(new Request(url, { headers }))).status).toBe(200);
  url.searchParams.set("status", "invalid");
  expect((await GET(new Request(url, { headers }))).status).toBe(400);
  url.searchParams.set("status", "needs_review");
  url.searchParams.set("size", String(settings.dashboard.max_page_size + 1));
  expect((await GET(new Request(url, { headers }))).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
