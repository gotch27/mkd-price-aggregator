import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { settings } from "@/nextsignal/config";
import { pool, transaction } from "@/nextsignal/services/database";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import {
  getProduct,
  refreshSourcePrices,
  refreshIdentitySafety,
} from "@/nextsignal/services/matching-repository";
import { repairIdentityBatch } from "@/nextsignal/services/store-product-identity-repair";
import { inputFingerprint } from "@/nextsignal/domain/matching";
import { hash, normalizeName } from "@/nextsignal/domain/normalize";
import { readSettings } from "@/nextsignal/services/task-settings";
import type { CatalogRow } from "@/nextsignal/domain/types";
const name = "Example chocolate 100 g";
const row = (key: string, label = name): CatalogRow => ({
  key,
  name: label,
  description: null,
  category: null,
  gtin: null,
  price: "40.00",
  regular_price: null,
  promo_price: null,
  unit_price: null,
  available: true,
  promotion: null,
  source_updated_at: null,
  raw: {},
});
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated test database required");
  vi.restoreAllMocks();
  await pool.query("TRUNCATE retailers,products,runs,sources,listings CASCADE");
  await seedRetailers();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await pool.end();
});
async function publish(branch: string, rows: CatalogRow[]) {
  const source = (
    await pool.query(
      `INSERT INTO sources(retailer,external_id,name,url,scope,meta)
    VALUES('vero',$1,$1,$2,'branch','{}') ON CONFLICT(retailer,external_id) DO UPDATE SET active=true RETURNING id`,
      [branch, settings.sources.vero.url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", "vero", source, null);
  await stagePage(run, {
    rows,
    next: null,
    total: rows.length,
    artifact: null,
  });
  const result = await publishCatalog(await getRun(run.id));
  if (result.status === "quarantined") {
    const confirmation = (
      await pool.query(
        "SELECT id FROM runs WHERE checkpoint->>'confirmation_of'=$1",
        [run.id],
      )
    ).rows[0];
    const retry = await getRun(confirmation.id);
    await stagePage(retry, {
      rows,
      next: null,
      total: rows.length,
      artifact: null,
    });
    await publishCatalog(await getRun(retry.id));
  }
  return source;
}
it("keeps descriptive identity stable when a branch reports a duplicate identifier", async () => {
  const input = {
    name,
    description: null,
    category: null,
    gtin: null,
    ambiguous: false,
  };
  expect(inputFingerprint(input)).toBe(
    inputFingerprint({ ...input, ambiguous: true }),
  );
  await publish("one", [row("item")]);
  const original = (await pool.query("SELECT id FROM store_products")).rows[0]
    .id;
  await publish("two", [row("item"), row("item")]);
  const products = (
    await pool.query("SELECT * FROM store_products ORDER BY external_key")
  ).rows;
  expect(products).toHaveLength(1); // repeated observations share one store product
  expect(products[0]).toMatchObject({
    id: original,
    ambiguous: false,
    branch_conflict: false,
  });
  expect((await pool.query("SELECT * FROM offers")).rows).toHaveLength(3);
  await publish("one", [row("item")]);
  expect((await getProduct(original)).ambiguous).toBe(false); // identical repeats are safe
  await publish("two", [row("item")]);
  expect((await getProduct(original)).ambiguous).toBe(false);
  expect(
    (await pool.query("SELECT * FROM store_products WHERE branch_conflict"))
      .rowCount,
  ).toBe(0);
});
it("still flags genuinely conflicting branch descriptions", async () => {
  await publish("one", [row("item")]);
  await publish("two", [row("item", "Example chocolate 200 g")]);
  expect(
    (await pool.query("SELECT * FROM store_products WHERE branch_conflict"))
      .rowCount,
  ).toBe(2);
});
it("ignores inactive or removed ambiguous observations and retains inactive product memory", async () => {
  const duplicates = await publish("duplicates", [
    row("item"),
    row("item", "Example chocolate 200 g"),
  ]);
  await publish("clean", [row("item")]);
  const products = (
    await pool.query(
      "SELECT id,external_key,group_id FROM store_products ORDER BY external_key",
    )
  ).rows;
  const ids = products.map((p) => p.id);
  await pool.query("UPDATE sources SET active=false WHERE id=$1", [duplicates]);
  await transaction((c) => refreshIdentitySafety(c, ids));
  expect((await getProduct(products[0].id)).ambiguous).toBe(false);
  expect((await getProduct(products[1].id)).ambiguous).toBe(true);
  await pool.query("UPDATE sources SET active=true WHERE id=$1", [duplicates]);
  await pool.query("DELETE FROM offers WHERE source_id=$1", [duplicates]);
  await transaction((c) => refreshIdentitySafety(c, ids));
  expect((await getProduct(products[0].id)).ambiguous).toBe(false);
  expect((await getProduct(products[1].id)).ambiguous).toBe(true);
  expect(
    (
      await pool.query(
        "SELECT id,external_key,group_id FROM store_products ORDER BY external_key",
      )
    ).rows,
  ).toEqual(products);
});
async function legacyTwin() {
  await publish("one", [row("item")]);
  const source = await publish("two", [row("item"), row("item")]);
  const canonical = (
    await pool.query("SELECT * FROM store_products WHERE external_key='item:1'")
  ).rows[0];
  const old = randomUUID();
  const group = randomUUID();
  const fingerprint = hash({
    name: normalizeName(name),
    description: null,
    category: null,
    gtin: null,
    ambiguous: true,
  });
  await transaction(async (c) => {
    await c.query(
      "INSERT INTO products(id,name,normalized_name,attributes) SELECT $1,name,normalized_name,attributes FROM products WHERE id=$2",
      [group, canonical.group_id],
    );
    await c.query(
      `INSERT INTO store_products SELECT (jsonb_populate_record(NULL::store_products,to_jsonb(sp)||
      jsonb_build_object('id',$2::text,'group_id',$3::text,'fingerprint',$4::text,'manual_facts','{}'::jsonb))).*
      FROM store_products sp WHERE id=$1`,
      [canonical.id, old, group, fingerprint],
    );
    await c.query(
      "UPDATE store_product_aliases SET store_product_id=$2 WHERE source_id=$1 AND store_product_id=$3",
      [source, old, canonical.id],
    );
    await c.query(
      "INSERT INTO store_product_observations(listing_id,store_product_id,previous_group_id) SELECT listing_id,$1,$2 FROM store_product_aliases WHERE store_product_id=$1",
      [old, group],
    );
    await c.query(
      "INSERT INTO matching_work(store_product_id,reason) VALUES($1,'Old duplicate')",
      [old],
    );
    await c.query(
      `INSERT INTO store_match_decisions(store_product_id,group_id,outcome,reason,input_key,source_version,evidence,prompt_version)
      VALUES($1,$2,'needs_info','Old saved decision','old-input',1,'{}','test')`,
      [old, group],
    );
    await refreshSourcePrices(c, source);
    // Reproduce the old reliability-only revision produced before this fix.
    await c.query(
      "UPDATE store_products SET ambiguous=true WHERE id=ANY($1::uuid[])",
      [[canonical.id, old]],
    );
  });
  return { canonical, old, group };
}
it("repairs existing ambiguity twins without deleting IDs, decisions, or human corrections", async () => {
  const { canonical, old } = await legacyTwin();
  await pool.query(
    `UPDATE store_products SET manual_facts='{"brand":"Human correction"}' WHERE id=$1`,
    [canonical.id],
  );
  await readSettings();
  await pool.query(
    "UPDATE operational_settings SET policy=jsonb_set(policy,'{paused}','true')",
  );
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const dry = await repairIdentityBatch({
    after: null,
    limit: 100,
    apply: false,
  });
  expect(dry.consolidated).toBe(1);
  expect(
    (await pool.query("SELECT * FROM store_product_redirects")).rowCount,
  ).toBe(0);
  const repaired = await repairIdentityBatch({
    after: null,
    limit: 100,
    apply: true,
  });
  expect(repaired.consolidated).toBe(1);
  expect((await getProduct(old)).id).toBe(canonical.id);
  expect((await getProduct(canonical.id)).manual_facts).toEqual({
    brand: "Human correction",
  });
  expect(await getProduct(canonical.id)).toMatchObject({
    ambiguous: false,
    branch_conflict: false,
  });
  expect(
    (
      await pool.query(
        "SELECT * FROM store_product_aliases WHERE store_product_id=$1",
        [canonical.id],
      )
    ).rowCount,
  ).toBe(3);
  expect(
    (await pool.query("SELECT * FROM store_products WHERE id=$1", [old]))
      .rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT * FROM store_match_decisions WHERE store_product_id=$1",
        [old],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT * FROM store_product_observations WHERE store_product_id=$1",
        [old],
      )
    ).rowCount,
  ).toBe(2);
  expect((await pool.query("SELECT * FROM offers")).rowCount).toBe(3);
  expect(
    (await repairIdentityBatch({ after: null, limit: 100, apply: true }))
      .consolidated,
  ).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
});
it("does not choose between two protected revisions or apply a repair while work is enabled", async () => {
  const { canonical, old } = await legacyTwin();
  await readSettings();
  await pool.query(
    "UPDATE operational_settings SET policy=jsonb_set(policy,'{paused}','false')",
  );
  await expect(
    repairIdentityBatch({ after: null, limit: 100, apply: true }),
  ).rejects.toThrow("Pause all work");
  await pool.query(
    "UPDATE operational_settings SET policy=jsonb_set(policy,'{paused}','true')",
  );
  await pool.query(
    `UPDATE store_products SET manual_facts='{"brand":"Preserved"}' WHERE id=ANY($1::uuid[])`,
    [[canonical.id, old]],
  );
  expect(
    (await repairIdentityBatch({ after: null, limit: 100, apply: true }))
      .skipped,
  ).toBe(1);
  expect(
    (await pool.query("SELECT * FROM store_product_redirects")).rowCount,
  ).toBe(0);
});
it("keeps a human-corrected ambiguity revision as canonical even when the clean hash already exists", async () => {
  const { canonical, old } = await legacyTwin();
  await readSettings();
  await pool.query(
    "UPDATE operational_settings SET policy=jsonb_set(policy,'{paused}','true')",
  );
  await pool.query(
    `UPDATE store_products SET manual_facts='{"brand":"Corrected old revision"}' WHERE id=$1`,
    [old],
  );
  const result = await repairIdentityBatch({
    after: null,
    limit: 100,
    apply: true,
  });
  expect(result.consolidated).toBe(1);
  expect((await getProduct(canonical.id)).id).toBe(old);
  expect((await getProduct(old)).manual_facts).toEqual({
    brand: "Corrected old revision",
  });
  expect((await getProduct(old)).fingerprint).toBe(
    inputFingerprint(await getProduct(old)),
  );
  expect((await pool.query("SELECT * FROM offers")).rowCount).toBe(3);
});
it("corrects cached dimension pack mistakes, preserves real packs and manual overrides, and queues no AI", async () => {
  const { repairPackBatch } =
    await import("@/nextsignal/services/product-pack-repair");
  await publish("one", [
    row("rule", "Kitchen tray 35×26 cm"),
    row("qwen", "Kitchen tray 20 x 15 cm"),
    row("manual", "Kitchen tray 30 x 10 cm"),
    row("real", "Example chocolate 6 x 100 g"),
  ]);
  const products = (
    await pool.query("SELECT * FROM store_products ORDER BY external_key")
  ).rows;
  for (const product of products.filter((p) => p.external_key !== "real:1")) {
    const manual = product.external_key === "manual:1";
    const fact = {
      value: manual ? "2" : "35",
      quote: manual ? "2" : product.name,
      source: manual ? "manual" : "name",
      method: manual
        ? "manual"
        : product.external_key === "qwen:1"
          ? "qwen"
          : "rule",
    };
    await pool.query(
      "UPDATE store_products SET facts=facts||jsonb_build_object('pack',$2::jsonb),manual_facts=$3 WHERE id=$1",
      [
        product.id,
        JSON.stringify(fact),
        JSON.stringify(manual ? { pack: "2" } : {}),
      ],
    );
  }
  await pool.query(
    `UPDATE listings SET attributes=jsonb_set(attributes,'{pack}','35') WHERE external_key<>'real:1'`,
  );
  await readSettings();
  await pool.query(
    "UPDATE operational_settings SET policy=jsonb_set(policy,'{paused}','true')",
  );
  const before = (
    await pool.query("SELECT id,group_id FROM store_products ORDER BY id")
  ).rows;
  const work = (
    await pool.query("SELECT id,state FROM matching_work ORDER BY id")
  ).rows;
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  expect(
    (
      await repairPackBatch({
        phase: "store-products",
        after: null,
        limit: 100,
        apply: false,
      })
    ).changed,
  ).toBe(2);
  expect(
    (
      await repairPackBatch({
        phase: "store-products",
        after: null,
        limit: 100,
        apply: true,
      })
    ).changed,
  ).toBe(2);
  expect(
    (
      await repairPackBatch({
        phase: "listings",
        after: null,
        limit: 100,
        apply: true,
      })
    ).changed,
  ).toBe(3);
  const after = (
    await pool.query("SELECT * FROM store_products ORDER BY external_key")
  ).rows;
  expect(
    after.find((p) => p.external_key === "manual:1").facts.pack,
  ).toMatchObject({ value: "2", method: "manual" });
  expect(
    after.find((p) => p.external_key === "real:1").facts.pack,
  ).toMatchObject({ value: "6", method: "rule" });
  expect(
    after.find((p) => p.external_key === "rule:1").facts.pack,
  ).toBeUndefined();
  expect(
    after.find((p) => p.external_key === "qwen:1").facts.pack,
  ).toBeUndefined();
  expect(
    (await pool.query("SELECT id,group_id FROM store_products ORDER BY id"))
      .rows,
  ).toEqual(before);
  expect(
    (await pool.query("SELECT id,state FROM matching_work ORDER BY id")).rows,
  ).toEqual(work);
  expect(
    (
      await repairPackBatch({
        phase: "store-products",
        after: null,
        limit: 100,
        apply: true,
      })
    ).changed,
  ).toBe(0);
  expect(
    (
      await repairPackBatch({
        phase: "listings",
        after: null,
        limit: 100,
        apply: true,
      })
    ).changed,
  ).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
});
