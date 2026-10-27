import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { settings } from "@/nextsignal/config";
import { pool, transaction } from "@/nextsignal/services/database";
import { seedRetailers } from "@/nextsignal/services/catalog-repository";
import { indexListings } from "@/nextsignal/services/matching-repository";
import { hash, normalizeName } from "@/nextsignal/domain/normalize";

type SourceListing = Parameters<typeof indexListings>[1][number];
const name = "Example milk 1L";

beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  await pool.query("TRUNCATE retailers,sources,runs,products,listings CASCADE");
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

async function group() {
  return (
    await pool.query<{ id: string }>(
      "INSERT INTO products(name,normalized_name,attributes) VALUES($1,$2,'{}') RETURNING id",
      [name, normalizeName(name)],
    )
  ).rows[0].id;
}

async function observation(
  productId: string = "",
  status = "separate",
): Promise<SourceListing> {
  const namespace = randomUUID();
  const source = (
    await pool.query<{ id: string }>(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES('spar',$1,$1,$2,'branch','{}') RETURNING id",
      [namespace, settings.sources.spar.url],
    )
  ).rows[0].id;
  const product = productId || (await group());
  const identity = hash({ name });
  const listing = (
    await pool.query<{ id: string }>(
      `INSERT INTO listings(retailer,namespace,external_key,name,raw,identity_hash,normalized_name,attributes,product_id,match_status)
       VALUES('spar',$1,'milk',$2,'{}',$3,$4,'{}',$5,$6) RETURNING id`,
      [namespace, name, identity, normalizeName(name), product, status],
    )
  ).rows[0].id;
  return {
    id: listing,
    retailer: "spar",
    external_key: "milk",
    identity_hash: identity,
    product_id: product,
    source_id: source,
    match_status: status,
    name,
    description: null,
    category: null,
    gtin: null,
    ambiguous: false,
  };
}

async function canonical() {
  return (await pool.query("SELECT * FROM store_products")).rows[0];
}

it("inserts a missing chain product and retains its source mapping and history", async () => {
  const row = await observation();
  const changes = await transaction((c) => indexListings(c, [row]));
  expect(changes).toMatchObject({
    observations: 1,
    products_changed: 1,
    work_queued: 1,
  });
  expect(await canonical()).toMatchObject({
    retailer: "spar",
    external_key: "milk",
    group_id: row.product_id,
    state: "pending",
  });
  expect(
    (await pool.query("SELECT * FROM store_product_aliases")).rowCount,
  ).toBe(1);
  expect(
    (await pool.query("SELECT * FROM store_product_observations")).rowCount,
  ).toBe(1);
  expect(
    (await pool.query("SELECT * FROM product_membership_history")).rowCount,
  ).toBe(1);
});

it("reuses saved facts and a manual group for another branch without update-locking the canonical product", async () => {
  const first = await observation();
  await transaction((c) => indexListings(c, [first]));
  const original = await canonical();
  const manualGroup = await group();
  const brand = {
    value: "Human brand",
    quote: "Human brand",
    source: "manual",
    method: "manual",
  };
  await pool.query(
    "UPDATE store_products SET group_id=$2,state='matched',manual_facts=$3,facts=facts||jsonb_build_object('brand',$4::jsonb) WHERE id=$1",
    [original.id, manualGroup, { brand: brand.value }, JSON.stringify(brand)],
  );
  const saved = await canonical();
  const copy = await observation();
  await transaction(async (c) => {
    const result = await indexListings(c, [copy]);
    expect(result).toMatchObject({
      observations: 1,
      products_changed: 0,
      work_queued: 0,
    });
    // The publication transaction remains open. A manual non-key edit should
    // not be blocked by unchanged-branch UPSERT locks.
    await transaction((other) =>
      other.query(
        "SELECT id FROM store_products WHERE id=$1 FOR NO KEY UPDATE NOWAIT",
        [original.id],
      ),
    );
  });
  expect(await canonical()).toMatchObject({
    id: original.id,
    group_id: manualGroup,
    facts: saved.facts,
    manual_facts: saved.manual_facts,
    version: saved.version,
  });
  expect((await pool.query("SELECT * FROM store_products")).rowCount).toBe(1);
  expect(
    (await pool.query("SELECT * FROM store_product_aliases")).rowCount,
  ).toBe(2);
  expect(
    (await pool.query("SELECT * FROM store_product_observations")).rowCount,
  ).toBe(2);
  expect(
    (await pool.query("SELECT * FROM product_membership_history")).rowCount,
  ).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});

it("still promotes a pending product when preserving a previously accepted branch match", async () => {
  const first = await observation();
  await transaction((c) => indexListings(c, [first]));
  const original = await canonical();
  const acceptedGroup = await group();
  const matched = await observation(acceptedGroup, "matched");
  const changes = await transaction((c) => indexListings(c, [matched]));
  expect(changes.products_changed).toBe(1);
  expect(await canonical()).toMatchObject({
    id: original.id,
    group_id: acceptedGroup,
    state: "matched",
    facts: original.facts,
  });
  expect(
    (await pool.query("SELECT * FROM store_product_aliases")).rowCount,
  ).toBe(2);
  expect(
    (await pool.query("SELECT * FROM product_membership_history")).rowCount,
  ).toBe(2);
});

it("handles a canonical product inserted by another transaction after the missing-identity read", async () => {
  const first = await observation();
  const concurrent = await observation();
  let insertedDuringRead = false;
  const changes = await transaction(async (c) => {
    const query = c.query;
    const intercepted = vi.spyOn(c, "query").mockImplementation((async (
      ...args: unknown[]
    ) => {
      const result = await Reflect.apply(query, c, args);
      if (
        !insertedDuringRead &&
        typeof args[0] === "string" &&
        args[0].includes("FOR KEY SHARE OF sp")
      ) {
        insertedDuringRead = true;
        await transaction((other) => indexListings(other, [concurrent]));
      }
      return result;
    }) as typeof c.query);
    try {
      return await indexListings(c, [first]);
    } finally {
      intercepted.mockRestore();
    }
  });
  expect(insertedDuringRead).toBe(true);
  expect(changes.products_changed).toBe(0);
  expect((await pool.query("SELECT * FROM store_products")).rowCount).toBe(1);
  expect(await canonical()).toMatchObject({
    group_id: concurrent.product_id,
    state: "pending",
  });
  expect(
    (await pool.query("SELECT * FROM store_product_aliases")).rowCount,
  ).toBe(2);
  expect(
    (await pool.query("SELECT * FROM store_product_observations")).rowCount,
  ).toBe(2);
  expect((await pool.query("SELECT * FROM matching_work")).rowCount).toBe(1);
});
