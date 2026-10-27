import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import {
  readProductStatistics,
  refreshProductStatistics,
} from "@/nextsignal/services/product-statistics";
import { readDashboard } from "@/nextsignal/services/dashboard-read";
import type { Retailer, CatalogRow } from "@/nextsignal/domain/types";

beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  await pool.query(
    "TRUNCATE retailers,sources,runs,products,listings,operational_settings,task_executions CASCADE",
  );
  await seedRetailers();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected external request");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => pool.end());
const input: CatalogRow = {
  key: "cola",
  name: "Coca Cola Original 330ml",
  description: null,
  category: null,
  gtin: null,
  price: "50.00",
  regular_price: null,
  promo_price: null,
  unit_price: null,
  available: true,
  promotion: null,
  source_updated_at: null,
  raw: {},
};
async function publish(
  retailer: Retailer,
  branch: string,
  changes: Partial<CatalogRow> = {},
) {
  const s = (
    await pool.query(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,$2,$3,'branch','{}') RETURNING id",
      [retailer, branch, settings.sources[retailer].url],
    )
  ).rows[0];
  const r = await createRun("catalog", retailer, s.id, null);
  await stagePage(r, {
    rows: [{ ...input, ...changes }],
    next: null,
    total: 1,
    artifact: null,
  });
  await publishCatalog(await getRun(r.id));
  return s.id as string;
}

it("stores exact branch-deduplicated counts and updates them after a manual group change", async () => {
  await publish("kam", "one");
  await publish("kam", "two");
  await publish("spar", "other");
  expect(await refreshProductStatistics(true)).toBe(true);
  expect((await readProductStatistics()).counts).toMatchObject({
    catalog_items: 2,
    universal_products: 2,
    cross_store_products: 0,
  });
  expect((await readProductStatistics()).retailer_counts).toEqual({
    kam: 1,
    spar: 1,
  });
  const kam = (
    await pool.query("SELECT group_id FROM store_products WHERE retailer='kam'")
  ).rows[0];
  await pool.query(
    "UPDATE store_products SET group_id=$1,state='matched' WHERE retailer='spar'",
    [kam.group_id],
  );
  expect((await readProductStatistics()).pending).toBe(true);
  await refreshProductStatistics(true);
  expect((await readProductStatistics()).counts).toMatchObject({
    catalog_items: 2,
    universal_products: 1,
    cross_store_products: 1,
  });
  expect((await readProductStatistics()).retailer_counts).toEqual({
    kam: 1,
    spar: 1,
  });
  expect((await readProductStatistics()).pending).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it("counts listed out-of-stock products once across branches and excludes retired catalogs", async () => {
  const first = await publish("spar", "one", { available: false });
  const second = await publish("spar", "two", { available: true });
  await publish("kam", "other", { available: false });
  await refreshProductStatistics(true);
  expect((await readProductStatistics()).retailer_counts).toEqual({
    spar: 1,
    kam: 1,
  });
  await pool.query("UPDATE sources SET active=false WHERE id=$1", [first]);
  await refreshProductStatistics(true);
  expect((await readProductStatistics()).retailer_counts).toEqual({
    spar: 1,
    kam: 1,
  });
  await pool.query("UPDATE sources SET active=false WHERE id=$1", [second]);
  await refreshProductStatistics(true);
  expect((await readProductStatistics()).retailer_counts).toEqual({ kam: 1 });
  expect(fetch).not.toHaveBeenCalled();
});

it("does not merge different article identifiers just because their names match", async () => {
  await publish("spar", "one");
  await publish("spar", "two", { key: "another-article" });
  await refreshProductStatistics(true);
  expect((await readProductStatistics()).retailer_counts).toEqual({ spar: 2 });
  expect((await readProductStatistics()).counts.catalog_items).toBe(2);
});

it("marks an uninitialized per-store snapshot as pending rather than a known zero", async () => {
  await publish("kam", "one");
  await refreshProductStatistics(true);
  await pool.query(
    "UPDATE dashboard_product_snapshot SET retailer_counts=NULL WHERE id",
  );
  expect(await readProductStatistics()).toMatchObject({
    retailer_counts: null,
    pending: true,
  });
  await refreshProductStatistics(true);
  expect(await readProductStatistics()).toMatchObject({
    retailer_counts: { kam: 1 },
    pending: false,
  });
});

it("serves Overview from its saved snapshot without running a product or branch recount", async () => {
  await publish("kam", "one");
  await refreshProductStatistics(true);
  const queries = vi.spyOn(pool, "query");
  const summary = await readDashboard({
    view: "summary",
    search: "",
    page: 1,
    size: 30,
  });
  const sql = queries.mock.calls
    .map((c) => (typeof c[0] === "string" ? c[0] : ""))
    .join("\n");
  queries.mockRestore();
  expect(summary).toMatchObject({
    counts: { catalog_items: 1, offers: "1" },
    statistics_pending: false,
  });
  expect(
    "retailers" in summary && summary.retailers.find((r) => r.slug === "kam"),
  ).toMatchObject({ unique_products: 1, offers: 1 });
  expect(
    "retailers" in summary && summary.retailers.find((r) => r.slug === "spar"),
  ).toMatchObject({ unique_products: 0, offers: 0 });
  expect(sql).not.toContain("store_product_identity_browser");
  expect(sql).not.toContain("store_product_browser");
  expect(sql).not.toContain("WITH visible AS MATERIALIZED");
});

it("retains an earlier uncommitted invalidation when a newer event is refreshed first", async () => {
  const source = await publish("kam", "one");
  await refreshProductStatistics(true);
  const late = await pool.connect();
  await late.query("BEGIN");
  const originals: Array<{ client: PoolClient; query: PoolClient["query"] }> =
    [];
  let committed = false;
  try {
    await late.query("UPDATE sources SET active=false WHERE id=$1", [source]);
    await pool.query(
      "INSERT INTO dashboard_refresh_events(transaction_id) VALUES(txid_current()) ON CONFLICT DO NOTHING",
    );
    const connect = pool.connect.bind(pool);
    const wrap = (client: PoolClient) => {
      const query = client.query;
      originals.push({ client, query });
      client.query = (async (...args: unknown[]) => {
        const result = await Reflect.apply(query, client, args);
        if (
          !committed &&
          typeof args[0] === "string" &&
          args[0].includes("WITH active AS MATERIALIZED")
        ) {
          await late.query("COMMIT");
          committed = true;
        }
        return result;
      }) as PoolClient["query"];
      return client;
    };
    type Callback = Parameters<typeof pool.connect>[0];
    const intercepted = ((callback?: Callback) =>
      callback
        ? connect((error, client, release) =>
            callback(error, client ? wrap(client) : client, release),
          )
        : connect().then(wrap)) as typeof pool.connect;
    vi.spyOn(pool, "connect").mockImplementation(intercepted);
    expect(await refreshProductStatistics(true)).toBe(true);
    expect(committed).toBe(true);
  } finally {
    vi.restoreAllMocks();
    for (const { client, query } of originals) client.query = query;
    if (!committed) await late.query("ROLLBACK");
    late.release();
  }
  expect((await readProductStatistics()).counts.catalog_items).toBe(1);
  expect((await readProductStatistics()).pending).toBe(true);
  await refreshProductStatistics(true);
  expect((await readProductStatistics()).counts.catalog_items).toBe(0);
  expect((await readProductStatistics()).retailer_counts).toEqual({});
  expect((await readProductStatistics()).pending).toBe(false);
});

it("keeps the last valid totals and dirty events when a statistics rebuild fails", async () => {
  await publish("kam", "one");
  await refreshProductStatistics(true);
  const original = await readProductStatistics();
  await pool.query("UPDATE store_products SET state='needs_info'");
  const database = await import("@/nextsignal/services/database");
  vi.spyOn(database, "transaction").mockRejectedValueOnce(
    new Error("Temporary database interruption"),
  );
  expect(await refreshProductStatistics(true)).toBe(false);
  const current = await readProductStatistics();
  expect(current.counts).toEqual(original.counts);
  expect(current.retailer_counts).toEqual(original.retailer_counts);
  expect(current.updated_at).toEqual(original.updated_at);
  expect(current.pending).toBe(true);
});
