import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import * as brands from "@/nextsignal/services/brands";
import {
  matchingRules,
  withBrandCatalog,
} from "@/nextsignal/services/brand-catalog";
import {
  BrandConflict,
  type Brand,
  type BrandInput,
} from "@/nextsignal/domain/brands";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import { normalizeName } from "@/nextsignal/domain/normalize";
import type { CatalogRow, Retailer } from "@/nextsignal/domain/types";
import { readDashboard } from "@/nextsignal/services/dashboard-read";
import { detailsForProduct } from "@/nextsignal/services/product-browser";
import { refreshBrowser } from "@/nextsignal/services/catalog-browser";
import { classificationRequest } from "@/nextsignal/services/ai-gateway";
import { getProduct } from "@/nextsignal/services/matching-repository";

const created: string[] = [];
const unique = () => `Audit brand ${randomUUID()}`;
async function create(input: Partial<BrandInput> = {}): Promise<Brand> {
  const result = await brands.save(
    { name: unique(), aliases: [], ...input },
    "brand-reviewer",
  );
  created.push(result.id);
  return result;
}
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated test database required");
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Brand management must not call a provider");
    }),
  );
  await pool.query(
    "TRUNCATE retailers,products,runs,sources,listings,logs CASCADE",
  );
  await seedRetailers();
});
afterAll(async () => {
  await pool.query("TRUNCATE retailers,products,runs,sources,listings CASCADE");
  // Delete only brands made by these tests; never clear the starter dictionary.
  await pool.query("DELETE FROM brand_edits WHERE brand_id=ANY($1::uuid[])", [
    created,
  ]);
  await pool.query("DELETE FROM brand_aliases WHERE brand_id=ANY($1::uuid[])", [
    created,
  ]);
  await pool.query("DELETE FROM brands WHERE id=ANY($1::uuid[])", [created]);
  vi.unstubAllGlobals();
  await pool.end();
});

it("creates editable brands with normalized aliases, an audit record and no AI", async () => {
  const name = unique();
  const result = await create({
    name,
    aliases: [{ name: "  Тест Бренд  " + randomUUID(), retailer: null }],
  });
  expect(result).toMatchObject({ name, revision: 1, product_count: 0 });
  expect(result.aliases).toHaveLength(2);
  const saved = (
    await pool.query(
      "SELECT normalized_name FROM brand_aliases WHERE brand_id=$1",
      [result.id],
    )
  ).rows;
  expect(
    saved.every(
      (row) => row.normalized_name === normalizeName(row.normalized_name),
    ),
  ).toBe(true);
  const [audit] = (
    await pool.query(
      "SELECT actor,before_record,after_record FROM brand_edits WHERE brand_id=$1",
      [result.id],
    )
  ).rows;
  expect(audit).toMatchObject({
    actor: "brand-reviewer",
    before_record: null,
    after_record: { id: result.id, name },
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps stable IDs and canonical slugs when a display name changes", async () => {
  const original = await create();
  const updated = await brands.save(
    {
      name: "Updated " + original.name,
      aliases: original.aliases.map(({ name, retailer }) => ({
        name,
        retailer,
      })),
    },
    "editor",
    original.id,
    original.revision,
  );
  expect(updated).toMatchObject({
    id: original.id,
    slug: original.slug,
    name: "Updated " + original.name,
    revision: 2,
  });
  expect(
    updated.aliases.some(
      (alias) => normalizeName(alias.name) === normalizeName(original.slug),
    ),
  ).toBe(true);
  await expect(
    brands.save(
      { name: "Stale change", aliases: [] },
      "stale-editor",
      original.id,
      original.revision,
    ),
  ).rejects.toBeInstanceOf(BrandConflict);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM brand_edits WHERE brand_id=$1",
        [original.id],
      )
    ).rows[0].n,
  ).toBe(2);
});

it("keeps unchanged alias IDs and deduplicates equivalent spellings", async () => {
  const name = unique();
  const original = await create({
    name,
    aliases: [
      { name: name.toUpperCase(), retailer: null },
      { name, retailer: null },
    ],
  });
  expect(original.aliases).toHaveLength(1);
  const updated = await brands.save(
    { name, aliases: [{ name, retailer: null }] },
    "editor",
    original.id,
    original.revision,
  );
  expect(updated.aliases.map((alias) => alias.id)).toEqual(
    original.aliases.map((alias) => alias.id),
  );
});

it("allows different store-scoped spellings but rejects overlapping global or store aliases", async () => {
  const spelling = unique();
  await create({ aliases: [{ name: spelling, retailer: "kam" }] });
  const second = await create({
    aliases: [{ name: spelling, retailer: "spar" }],
  });
  await expect(
    brands.save(
      { name: second.name, aliases: [{ name: spelling, retailer: null }] },
      "editor",
      second.id,
      second.revision,
    ),
  ).rejects.toBeInstanceOf(BrandConflict);
  await expect(
    brands.save(
      { name: second.name, aliases: [{ name: spelling, retailer: "kam" }] },
      "editor",
      second.id,
      second.revision,
    ),
  ).rejects.toBeInstanceOf(BrandConflict);
  const alias = (
    await pool.query(
      "SELECT retailer FROM brand_aliases WHERE brand_id=$1 AND normalized_name=$2",
      [second.id, normalizeName(spelling)],
    )
  ).rows;
  expect(alias).toEqual([{ retailer: "spar" }]);
});

it("reads current database spellings by store and snapshots a task batch", async () => {
  const spelling = unique();
  const original = await create({
    aliases: [{ name: spelling, retailer: "kam" }],
  });
  const aliasesFor = async (retailer: string) =>
    (await matchingRules(pool, retailer)).brands.find(
      (brand) => brand.canonical === original.slug,
    )!.aliases;
  expect(await aliasesFor("kam")).toContain(normalizeName(spelling));
  expect(await aliasesFor("spar")).not.toContain(normalizeName(spelling));
  const added = unique();
  await withBrandCatalog(async () => {
    expect(await aliasesFor("kam")).not.toContain(normalizeName(added));
    await brands.save(
      {
        name: original.name,
        aliases: [
          { name: spelling, retailer: "kam" },
          { name: added, retailer: null },
        ],
      },
      "editor",
      original.id,
      original.revision,
    );
    expect(await aliasesFor("kam")).not.toContain(normalizeName(added));
  });
  expect(await aliasesFor("kam")).toContain(normalizeName(added));
});

it("lists and searches brands with bounded pages while options expose only IDs and display names", async () => {
  const alias = unique();
  const brand = await create({ aliases: [{ name: alias, retailer: null }] });
  const page = await brands.list(alias, 999, 1);
  expect(page).toMatchObject({
    total: 1,
    page: 1,
    page_size: 1,
    total_pages: 1,
  });
  expect(page.rows[0].id).toBe(brand.id);
  const option = (await brands.options()).rows.find(
    (row) => row.id === brand.id,
  );
  expect(option).toEqual({ id: brand.id, name: brand.name });
  expect(fetch).not.toHaveBeenCalled();
});

async function publish(
  name: string,
  retailer: Retailer = "kam",
  branch = "one",
  available = true,
) {
  const source = (
    await pool.query(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,$2,$3,'branch','{}') RETURNING id",
      [retailer, branch, settings.sources[retailer].url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", retailer, source, null);
  const row: CatalogRow = {
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
  };
  await stagePage(run, { rows: [row], next: null, total: 1, artifact: null });
  await publishCatalog(await getRun(run.id));
  return (
    await pool.query(
      "SELECT sp.*,$1::uuid AS source_id FROM store_products sp JOIN store_product_sources ss ON ss.store_product_id=sp.id WHERE ss.source_id=$1",
      [source],
    )
  ).rows[0];
}

it("connects published product brand evidence to stable brand records and clears missing evidence", async () => {
  const product = await publish("NIVEA CREME SOFT shower gel 250ml");
  const brand = (await pool.query("SELECT id FROM brands WHERE slug='nivea'"))
    .rows[0];
  expect(product.brand_id).toBe(brand.id);
  expect(product.facts.brand).toMatchObject({ value: "nivea", method: "rule" });
  await pool.query(
    "UPDATE store_products SET facts=facts-'brand' WHERE id=$1",
    [product.id],
  );
  expect(
    (
      await pool.query("SELECT brand_id FROM store_products WHERE id=$1", [
        product.id,
      ])
    ).rows[0].brand_id,
  ).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("combines brand filters with store, catalog and availability on products and shared groups", async () => {
  const kam = await publish("NIVEA CREME SOFT shower gel 250ml");
  const spar = await publish(
    "NIVEA CREME SOFT shower gel 250ml",
    "spar",
    "other",
    false,
  );
  const pepsi = await publish("Pepsi Original 330ml can", "kam", "pepsi");
  await refreshBrowser();
  const brandId = kam.brand_id as string;
  expect(typeof brandId).toBe("string");
  for (const view of ["products", "universal"] as const) {
    const base = { view, search: "", page: 1, size: 10, brand_id: brandId };
    const available = await readDashboard({
      ...base,
      availability: "available",
    });
    expect(available).toMatchObject({ total: 1 });
    expect(await readDashboard({ ...base, availability: "all" })).toMatchObject(
      { total: 2 },
    );
    expect(
      await readDashboard({
        ...base,
        retailer: "spar",
        availability: "unavailable",
      }),
    ).toMatchObject({ total: 1 });
    expect(
      await readDashboard({
        ...base,
        retailer: "spar",
        availability: "available",
      }),
    ).toMatchObject({ total: 0 });
    expect(
      await readDashboard({
        ...base,
        source_id: kam.source_id,
        retailer: "kam",
        availability: "available",
      }),
    ).toMatchObject({ total: 1 });
    expect(
      await readDashboard({
        ...base,
        source_id: spar.source_id,
        availability: "unavailable",
      }),
    ).toMatchObject({ total: 1 });
    expect(
      await readDashboard({
        ...base,
        source_id: pepsi.source_id,
        availability: "all",
      }),
    ).toMatchObject({ total: 0 });
    expect(
      await readDashboard({
        ...base,
        source_id: kam.source_id,
        retailer: "spar",
        availability: "all",
      }),
    ).toMatchObject({ total: 0 });
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("shows current display names without rewriting evidence or invalidating saved category inputs", async () => {
  const original = await create({
    name: "Zbrand" + randomUUID().replace(/[^a-z]/g, ""),
  });
  const product = await publish(`${original.name} shower gel 250ml`);
  expect(product.brand_id).toBe(original.id);
  const key = (await classificationRequest(await getProduct(product.id))).key;
  const updated = await brands.save(
    {
      name: "Display " + original.name,
      aliases: original.aliases.map(({ name, retailer }) => ({
        name,
        retailer,
      })),
    },
    "editor",
    original.id,
    original.revision,
  );
  const detail = await detailsForProduct(product.group_id);
  expect(detail?.listings[0].brand).toEqual({
    id: original.id,
    name: updated.name,
  });
  const saved = await getProduct(product.id);
  expect(saved.facts).toEqual(product.facts);
  expect(saved.version).toBe(Number(product.version));
  expect((await classificationRequest(saved)).key).toBe(key);
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects punctuation-only brand names and spellings without changing reference data", async () => {
  const before = (await pool.query("SELECT count(*)::int n FROM brands"))
    .rows[0].n;
  await expect(
    brands.save({ name: "...%", aliases: [] }, "editor"),
  ).rejects.toBeInstanceOf(BrandConflict);
  await expect(
    brands.save(
      { name: unique(), aliases: [{ name: "...%", retailer: null }] },
      "editor",
    ),
  ).rejects.toBeInstanceOf(BrandConflict);
  expect(
    (await pool.query("SELECT count(*)::int n FROM brands")).rows[0].n,
  ).toBe(before);
  expect(fetch).not.toHaveBeenCalled();
});

it("plans categorization using its transaction client when the pool has no spare connections", async () => {
  const product = await publish("NIVEA CREME SOFT shower gel 250ml");
  const clients = [];
  try {
    for (let n = 0; n < settings.database.pool_size; n++)
      clients.push(await pool.connect());
    // All slots are deliberately occupied. The supplied client must suffice.
    const plan = await classificationRequest(product, clients[0]);
    expect(plan.state.product.facts.brand).toBe("nivea");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    for (const c of clients) c.release();
  }
});
