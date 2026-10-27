import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import { getProduct } from "@/nextsignal/services/matching-repository";
import { offersForProduct } from "@/nextsignal/services/product-browser";
import { readDashboard } from "@/nextsignal/services/dashboard-read";
import { readSettings } from "@/nextsignal/services/task-settings";
import {
  deduplicateProductBatch,
  refreshDuplicatePricesBatch,
} from "@/nextsignal/services/source-product-deduplication";
import type { CatalogRow } from "@/nextsignal/domain/types";

beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  vi.restoreAllMocks();
  await pool.query(
    "TRUNCATE retailers,products,runs,sources,listings,operational_settings CASCADE",
  );
  await seedRetailers();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected external request");
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.end();
});
const row = (overrides: Partial<CatalogRow> = {}): CatalogRow => ({
  key: "stock",
  name: "Coca Cola Original 330 ml can",
  description: "Soft drink",
  category: "Drinks",
  gtin: null,
  price: "40.00",
  regular_price: null,
  promo_price: null,
  unit_price: null,
  available: true,
  promotion: null,
  source_updated_at: null,
  raw: {},
  ...overrides,
});
async function publish(branch: string, rows: CatalogRow[], split = false) {
  const source = (
    await pool.query(
      `INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES('zito',$1,$1,$2,'branch','{}') ON CONFLICT(retailer,external_id) DO UPDATE SET active=true RETURNING id`,
      [branch, settings.sources.zito.url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", "zito", source, null);
  if (split) {
    await stagePage(run, {
      rows: rows.slice(0, 1),
      next: "2",
      total: rows.length,
      artifact: null,
    });
    await stagePage(run, {
      rows: rows.slice(1),
      next: null,
      total: rows.length,
      artifact: null,
    });
  } else
    await stagePage(run, {
      rows,
      next: null,
      total: rows.length,
      artifact: null,
    });
  expect((await publishCatalog(await getRun(run.id))).status).toBe("success");
  return source;
}
async function canonical() {
  return (
    await pool.query(
      "SELECT * FROM store_products WHERE NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=store_products.id) ORDER BY external_key",
    )
  ).rows;
}
async function pause() {
  await readSettings();
  await pool.query(
    "UPDATE operational_settings SET policy=jsonb_set(policy,'{paused}','true')",
  );
}

it("combines exact repeated rows across pages and branches without losing observations, provenance or completeness", async () => {
  const first = await publish("one", [row(), row()], true);
  const original = (await canonical())[0];
  await publish("two", [row({ price: "45.00" })]);
  expect(await canonical()).toHaveLength(1);
  expect((await canonical())[0]).toMatchObject({
    id: original.id,
    ambiguous: false,
    branch_conflict: false,
  });
  expect((await pool.query("SELECT * FROM offers")).rowCount).toBe(3);
  expect(
    (await pool.query("SELECT row_count FROM sources WHERE id=$1", [first]))
      .rows[0].row_count,
  ).toBe(2);
  expect(
    (
      await pool.query(
        "SELECT duplicate_count,price_conflict,offer_count FROM store_product_sources WHERE source_id=$1",
        [first],
      )
    ).rows,
  ).toEqual([{ duplicate_count: 1, price_conflict: false, offer_count: 2 }]);
  const visible = await offersForProduct(original.group_id);
  expect(visible).toHaveLength(2);
  expect(visible.find((o) => o.source_id === first)?.repeated_rows).toBe("2");
  const logs = (
    await pool.query(
      "SELECT data FROM logs WHERE data->>'event'='catalog.duplicates.collapsed' AND source_id=$1",
      [first],
    )
  ).rows;
  expect(logs.at(-1)?.data).toMatchObject({
    identical_duplicate_rows: 1,
    unique_products: 1,
    source_rows: 2,
  });
});

it("retains both prices in one product and shows the full scoped range instead of a random occurrence", async () => {
  const source = await publish(
    "one",
    [row(), row({ price: "55.00" }), row()],
    true,
  );
  const products = await canonical();
  expect(products).toHaveLength(1);
  expect(products[0].ambiguous).toBe(false);
  expect(
    (
      await pool.query(
        "SELECT price,highest_price,price_conflict,duplicate_count FROM store_product_sources WHERE source_id=$1",
        [source],
      )
    ).rows,
  ).toEqual([
    {
      price: "40.00",
      highest_price: "55.00",
      price_conflict: true,
      duplicate_count: 1,
    },
  ]);
  const offers = await offersForProduct(products[0].group_id);
  expect(offers.map((o) => o.price)).toEqual(["40.00", "55.00"]);
  expect(offers.every((o) => o.price_conflict)).toBe(true);
  const page = await readDashboard({
    view: "products",
    source_id: source,
    page: 1,
    size: 10,
    search: "",
  });
  if (!("rows" in page)) throw new Error("Expected a product page");
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]).toMatchObject({
    price: "40.00",
    highest_price: "55.00",
  });
});

it("keeps different amounts, variants, barcodes and distinct source article codes separate", async () => {
  await publish(
    "one",
    [
      row(),
      row({ name: "Coca Cola Zero 330 ml can" }),
      row({ name: "Coca Cola Original 500 ml can" }),
      row({ gtin: "5449000000996" }),
      row({ key: "other-article" }),
    ],
    true,
  );
  const products = await canonical();
  expect(products).toHaveLength(5);
  expect(
    products
      .filter((p) => p.external_key === "stock:1")
      .every((p) => p.ambiguous && p.branch_conflict),
  ).toBe(true);
  expect(
    products.find((p) => p.external_key === "other-article:1"),
  ).toMatchObject({ ambiguous: false, branch_conflict: false });
});

async function oldOccurrence() {
  const source = await publish("one", [row(), row()], true);
  const original = (await canonical())[0],
    old = randomUUID(),
    group = randomUUID();
  await pool.query(
    `INSERT INTO products(id,name,normalized_name,attributes) SELECT $1,name,normalized_name,attributes FROM products WHERE id=$2`,
    [group, original.group_id],
  );
  await pool.query(
    `INSERT INTO store_products SELECT (jsonb_populate_record(NULL::store_products,to_jsonb(sp)||jsonb_build_object('id',$2::text,'group_id',$3::text,'external_key','stock:2','ambiguous',true))).* FROM store_products sp WHERE id=$1`,
    [original.id, old, group],
  );
  await pool.query(
    "UPDATE store_product_aliases SET store_product_id=$1 WHERE listing_id IN(SELECT id FROM listings WHERE external_key='stock:2')",
    [old],
  );
  await pool.query(
    `INSERT INTO store_match_decisions(store_product_id,group_id,outcome,reason,input_key,source_version,evidence,prompt_version) VALUES($1,$2,'needs_info','Original history','old',1,'{}','test')`,
    [old, group],
  );
  await pool.query("UPDATE store_products SET ambiguous=true WHERE id=$1", [
    original.id,
  ]);
  return { source, original, old, group };
}

it("repairs existing occurrences with durable redirects and retains all prices, original IDs and decision history", async () => {
  const { original, old, group } = await oldOccurrence();
  const before = (await pool.query("SELECT * FROM offers ORDER BY listing_id"))
    .rows;
  const dry = await deduplicateProductBatch({
    after: null,
    limit: 100,
    apply: false,
  });
  expect(dry.combined).toBe(1);
  expect(await canonical()).toHaveLength(2);
  await expect(
    deduplicateProductBatch({ after: null, limit: 100, apply: true }),
  ).rejects.toThrow("Pause all work");
  await pause();
  expect(
    (await deduplicateProductBatch({ after: null, limit: 100, apply: true }))
      .combined,
  ).toBe(1);
  expect((await getProduct(old)).id).toBe(original.id);
  expect(await canonical()).toHaveLength(1);
  expect(
    (await pool.query("SELECT * FROM offers ORDER BY listing_id")).rows,
  ).toEqual(before);
  expect(
    (
      await pool.query(
        "SELECT * FROM store_match_decisions WHERE store_product_id=$1",
        [old],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (await pool.query("SELECT redirect_id FROM products WHERE id=$1", [group]))
      .rows[0].redirect_id,
  ).toBe(original.group_id);
  expect(
    (await pool.query("SELECT * FROM store_product_deduplications")).rows[0]
      .previous_record.external_key,
  ).toBe("stock:2");
  await refreshDuplicatePricesBatch({ after: null, limit: 100, apply: true });
  expect((await getProduct(original.id)).ambiguous).toBe(false);
  expect(
    (await deduplicateProductBatch({ after: null, limit: 100, apply: true }))
      .combined,
  ).toBe(0);
  await publish(
    "one",
    [row({ price: "60.00" }), row({ price: "60.00" })],
    true,
  );
  expect(await canonical()).toHaveLength(1);
  expect((await getProduct(old)).id).toBe(original.id);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps a single human-corrected occurrence as canonical without losing its correction", async () => {
  const { original, old } = await oldOccurrence();
  await pool.query(
    `UPDATE store_products SET manual_facts='{"brand":"Corrected brand"}' WHERE id=$1`,
    [old],
  );
  await pause();
  await deduplicateProductBatch({ after: null, limit: 100, apply: true });
  expect((await getProduct(original.id)).id).toBe(old);
  expect(await getProduct(old)).toMatchObject({
    external_key: "stock:1",
    manual_facts: { brand: "Corrected brand" },
  });
  await publish("two", [row()]);
  expect(await canonical()).toHaveLength(1);
  expect((await getProduct(old)).manual_facts).toEqual({
    brand: "Corrected brand",
  });
});

it("preserves competing protected human records through repair and later imports instead of choosing a winner", async () => {
  const { original, old, source } = await oldOccurrence();
  await pool.query(
    `UPDATE store_products SET manual_facts=jsonb_build_object('brand',id::text) WHERE id=ANY($1::uuid[])`,
    [[original.id, old]],
  );
  await pause();
  expect(
    (await deduplicateProductBatch({ after: null, limit: 100, apply: true }))
      .retained_for_review,
  ).toBe(1);
  await refreshDuplicatePricesBatch({ after: null, limit: 100, apply: true });
  await publish("one", [row(), row()], true);
  expect(await canonical()).toHaveLength(2);
  expect(
    (await canonical()).every((p) => p.duplicate_conflict && p.ambiguous),
  ).toBe(true);
  expect(
    (
      await pool.query(
        "SELECT DISTINCT store_product_id FROM store_product_aliases WHERE source_id=$1",
        [source],
      )
    ).rowCount,
  ).toBe(2);
  expect(
    (await pool.query("SELECT * FROM store_product_redirects")).rowCount,
  ).toBe(0);
});

it.each(["active choice", "reset history"])(
  "preserves a human category record during duplicate consolidation: %s",
  async (mode) => {
    const { original, old, group } = await oldOccurrence();
    if (mode === "active choice")
      await pool.query(
        "UPDATE store_products SET manual_family='soft_drinks',classified_family='soft_drinks' WHERE id=$1",
        [old],
      );
    else
      await pool.query(
        "INSERT INTO product_category_edits(store_product_id,group_id,actor,action,before_manual,after_manual,before_category,after_category,note) VALUES($1,$2,'reviewer','reset','soft_drinks',NULL,'soft_drinks',NULL,'Preserve history')",
        [old, group],
      );
    await pause();
    await deduplicateProductBatch({ after: null, limit: 100, apply: true });
    expect((await getProduct(original.id)).id).toBe(old);
    if (mode === "active choice")
      expect((await getProduct(old)).manual_family).toBe("soft_drinks");
    else
      expect(
        (
          await pool.query(
            "SELECT * FROM product_category_edits WHERE store_product_id=$1",
            [old],
          )
        ).rowCount,
      ).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  },
);
