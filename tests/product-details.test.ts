import { beforeEach, afterAll, expect, it, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import { read, save } from "@/nextsignal/services/product-details";
import {
  search,
  save as saveMatch,
} from "@/nextsignal/services/manual-matching";
import {
  getProduct,
  saveClassification,
} from "@/nextsignal/services/matching-repository";
import { matchBatch } from "@/nextsignal/services/matching";
import { detailsForProduct } from "@/nextsignal/services/product-browser";
import { refreshProductFacts, type Family } from "@/nextsignal/domain/matching";
import { classificationRequest } from "@/nextsignal/services/ai-gateway";
import { sessionToken, SESSION_COOKIE } from "@/nextsignal/adapters/auth";
import { GET, PATCH } from "@/app/api/products/[id]/attributes/route";
import type { CatalogRow, Retailer } from "@/nextsignal/domain/types";
import type {
  DetailOverrides,
  EditableProduct,
} from "@/nextsignal/domain/product-edits";
const name = "Coca-Cola Original 330 ml can";
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated test database required");
  vi.restoreAllMocks();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Manual edits must not call a provider"),
  );
  await pool.query(
    "TRUNCATE retailers,products,runs,sources,listings,logs CASCADE",
  );
  await pool.query(
    "UPDATE matching_state SET cursor=NULL,completed=false WHERE key='store-products'",
  );
  await seedRetailers();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await pool.end();
});
async function publish(
  retailer: Retailer,
  label = name,
  branch = "one",
  price = "50.00",
  empty = false,
) {
  const source = (
    await pool.query(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,$2,$3,'branch','{}') ON CONFLICT(retailer,external_id) DO UPDATE SET active=true RETURNING id",
      [retailer, branch, settings.sources[retailer].url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", retailer, source, null);
  const row: CatalogRow = {
    key: "item",
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
  await stagePage(run, {
    rows: empty ? [] : [row],
    next: null,
    total: empty ? 0 : 1,
    artifact: null,
  });
  await publishCatalog(await getRun(run.id));
  return (
    await pool.query(
      "SELECT * FROM store_products WHERE retailer=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
      [retailer],
    )
  ).rows[0];
}
async function edit(
  product: EditableProduct,
  changes: DetailOverrides,
  action: "update" | "reset" = "update",
) {
  return save(
    {
      id: product.id,
      member_id: product.member_id,
      snapshot: product.snapshot,
      action,
      changes,
      note: "Checked the product packaging",
    },
    "test-admin",
  );
}
async function connect(a: string, b: string) {
  const first = (await search(a, "", 1)).group!,
    second = (await search(b, "", 1)).group!;
  expect(
    (
      await saveMatch(
        {
          id: first.id,
          action: "connect",
          snapshot: first.snapshot,
          candidate_id: second.id,
          candidate_snapshot: second.snapshot,
          note: "Same exact product",
        },
        "admin",
      )
    ).ok,
  ).toBe(true);
}
it("saves corrections, authenticated author and before/after history using the log adapter without modifying source rows", async () => {
  const p = await publish("dim", "АБСОЛУТ 40%АЛ 700МЛ СЕТ 2/1");
  const before = (await pool.query("SELECT name,attributes FROM listings"))
    .rows;
  const current = (await read(p.group_id, p.id))!;
  expect(
    await edit(current, { brand: "Absolut", alcohol: "40", pack: "2" }),
  ).toMatchObject({ ok: true, changed: true });
  const result = (await read(p.group_id, p.id))!;
  expect(result.facts.brand).toMatchObject({
    value: "absolut",
    method: "manual",
    source: "manual",
  });
  expect(result.history[0]).toMatchObject({
    actor: "test-admin",
    action: "update",
    note: "Checked the product packaging",
    changes: expect.arrayContaining([
      { field: "brand", before: null, after: "absolut" },
    ]),
  });
  expect(result.history[0].created_at).toBeTruthy();
  expect(
    (await pool.query("SELECT name,attributes FROM listings")).rows,
  ).toEqual(before);
  const logs = (
    await pool.query(
      "SELECT data FROM logs WHERE data->>'event'='products.details.updated'",
    )
  ).rows;
  expect(logs).toHaveLength(1);
  expect(logs[0].data).toMatchObject({
    actor: "test-admin",
    store_product_id: p.id,
    changes: expect.arrayContaining([
      { field: "brand", before: null, after: "absolut" },
    ]),
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("preserves corrections over branch copies, price changes, disappearance and return, and reuses them in matching reads", async () => {
  const p = await publish("kam");
  await edit((await read(p.group_id, p.id))!, { brand: "Corrected brand" });
  await publish("kam", name, "two", "40.00");
  await publish("kam", name, "one", "42.00");
  await publish("kam", name, "one", "42.00", true);
  await publish("kam", name, "one", "44.00");
  const product = await getProduct(p.id);
  expect(product.manual_facts).toEqual({ brand: "Corrected brand" });
  expect(
    refreshProductFacts(
      product,
      settings.matching.local,
      settings.matching.category_mappings,
    ).facts.brand?.value,
  ).toBe("corrected brand");
  const detail = (await detailsForProduct(p.group_id))!;
  expect(detail.listings[0].attributes).toMatchObject({
    brand: "corrected brand",
  });
  expect((await read(p.group_id, p.id))!.history_total).toBe(1);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("supports explicit unknown values, quantity conversion and restoring store details with retained history", async () => {
  const p = await publish("kam");
  await edit((await read(p.group_id, p.id))!, {
    brand: null,
    quantity: "0,5",
    unit: "l",
  });
  let current = (await read(p.group_id, p.id))!;
  expect(current.facts.brand).toBeUndefined();
  expect(current.facts.quantity?.value).toBe("500");
  expect(current.facts.unit?.value).toBe("ml");
  const job = await createRun("match", null, null, null);
  await matchBatch(job.id, null);
  expect((await read(p.group_id, p.id))!.facts.brand).toBeUndefined();
  current = (await read(p.group_id, p.id))!;
  expect(await edit(current, {}, "reset")).toMatchObject({
    ok: true,
    changed: true,
  });
  current = (await read(p.group_id, p.id))!;
  expect(current.overrides).toEqual({});
  expect(current.facts.brand?.value).toBeTruthy();
  expect(current.facts.quantity?.value).toBe("330");
  expect(current.history.map((e) => e.action)).toEqual(["reset", "update"]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("keeps saved connections when corrected facts conflict, flags them, and clears the flag when restored", async () => {
  const a = await publish("kam"),
    b = await publish("spar");
  await connect(a.group_id, b.group_id);
  await edit((await read(a.group_id, b.id))!, { quantity: "500", unit: "ml" });
  expect((await getProduct(b.id)).group_id).toBe(a.group_id);
  expect(
    (
      await pool.query("SELECT matching_conflict FROM products WHERE id=$1", [
        a.group_id,
      ])
    ).rows[0].matching_conflict,
  ).toBe(true);
  expect((await getProduct(a.id)).state).toBe("legacy_conflict");
  await edit((await read(a.group_id, b.id))!, {}, "reset");
  expect(
    (
      await pool.query("SELECT matching_conflict FROM products WHERE id=$1", [
        a.group_id,
      ])
    ).rows[0].matching_conflict,
  ).toBe(false);
  expect((await getProduct(b.id)).state).toBe("matched");
  expect(
    (await pool.query("SELECT * FROM manual_product_links WHERE action='same'"))
      .rowCount,
  ).toBe(1);
});
it("rejects stale/concurrent saves and does not add history for a no-op", async () => {
  const p = await publish("kam"),
    current = (await read(p.group_id, p.id))!;
  const result = await Promise.all([
    edit(current, { brand: "First" }),
    edit(current, { brand: "Second" }),
  ]);
  expect(result.filter((r) => r.ok)).toHaveLength(1);
  const saved = (await read(p.group_id, p.id))!;
  expect(saved.history_total).toBe(1);
  expect(await edit(saved, { brand: saved.overrides.brand })).toMatchObject({
    ok: true,
    changed: false,
  });
  expect((await read(p.group_id, p.id))!.history_total).toBe(1);
});
it("prepares only the selected legacy product and its branch aliases, without a catalog-wide backfill", async () => {
  const p = await publish("kam");
  await publish("kam", name, "two");
  await publish("spar", "Unrelated chair X9834");
  await pool.query("TRUNCATE store_products CASCADE");
  await pool.query("REFRESH MATERIALIZED VIEW catalog_browser");
  const listing = (
    await pool.query(
      "SELECT b.listing_id AS id,l.product_id FROM catalog_browser b JOIN listings l ON l.id=b.listing_id WHERE b.retailer='kam'",
    )
  ).rows[0];
  const legacy = (await read(listing.product_id, listing.id))!;
  expect(legacy).toBeTruthy();
  expect(await edit(legacy, { brand: "Cola" })).toMatchObject({
    ok: true,
    changed: true,
  });
  expect((await pool.query("SELECT 1 FROM store_products")).rowCount).toBe(1);
  expect(
    (await pool.query("SELECT 1 FROM store_product_aliases")).rowCount,
  ).toBe(2);
  expect(
    (await pool.query("SELECT 1 FROM product_detail_edits")).rowCount,
  ).toBe(1);
});
it("does not transfer human corrections to a genuinely different source revision", async () => {
  const p = await publish("kam");
  await edit((await read(p.group_id, p.id))!, { brand: "Corrected brand" });
  const changed = await publish("kam", name.replace("330", "500"));
  expect(changed.id).not.toBe(p.id);
  expect((await getProduct(changed.id)).manual_facts).toEqual({});
  expect((await read(p.group_id, p.id))!.history_total).toBe(1);
});
it.each([
  { pack: "1.5" },
  { gtin: "1234567890123" },
  { fat: "101" },
  { quantity: null },
  { unit: "litres" },
])(
  "rejects invalid values %j without saving or queuing them",
  async (changes) => {
    const p = await publish("kam");
    expect((await edit((await read(p.group_id, p.id))!, changes)).ok).toBe(
      false,
    );
    expect((await read(p.group_id, p.id))!.history_total).toBe(0);
    expect((await getProduct(p.id)).manual_facts).toEqual({});
  },
);
it("invalidates category request inputs for corrections without involving branch prices", async () => {
  const p = await publish("kam");
  const original = classificationRequest(await getProduct(p.id));
  await edit((await read(p.group_id, p.id))!, { brand: "Corrected brand" });
  const corrected = classificationRequest(await getProduct(p.id));
  expect(corrected.key).not.toBe(original.key);
  expect(corrected.state.product.facts.brand).toBe("corrected brand");
  await publish("kam", name, "one", "39.00");
  expect(classificationRequest(await getProduct(p.id)).key).toBe(corrected.key);
});
it("rolls back the audit and correction together if saving fails, and logs only the failure", async () => {
  const p = await publish("kam");
  const current = (await read(p.group_id, p.id))!;
  await pool.query(`CREATE FUNCTION test_reject_product_edit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Simulated edit failure'; END $$;
    CREATE TRIGGER test_reject_product_edit BEFORE UPDATE OF manual_facts ON store_products FOR EACH ROW EXECUTE FUNCTION test_reject_product_edit()`);
  try {
    await expect(edit(current, { brand: "Changed" })).rejects.toThrow(
      "Simulated edit failure",
    );
    expect((await read(p.group_id, p.id))!.history_total).toBe(0);
    expect((await getProduct(p.id)).manual_facts).toEqual({});
    expect(
      (
        await pool.query(
          "SELECT 1 FROM logs WHERE data->>'event'='products.details.updated'",
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM logs WHERE data->>'event'='products.details.failed'",
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    await pool.query(
      "DROP TRIGGER test_reject_product_edit ON store_products; DROP FUNCTION test_reject_product_edit()",
    );
  }
});
it("authorizes and validates the edit API and takes the actor from the session", async () => {
  const p = await publish("kam");
  const current = (await read(p.group_id, p.id))!;
  const url = `http://localhost:3000/api/products/${p.group_id}/attributes`;
  const context = { params: Promise.resolve({ id: p.group_id }) };
  const cookie = `${SESSION_COOKIE}=${sessionToken()}`;
  const body = {
    member_id: p.id,
    snapshot: current.snapshot,
    action: "update",
    changes: { brand: "Verified" },
    note: "",
  };
  expect(
    (await GET(new Request(`${url}?member_id=${p.id}`), context)).status,
  ).toBe(401);
  const editable = await GET(
    new Request(`${url}?member_id=${p.id}`, { headers: { cookie } }),
    context,
  );
  expect(editable.status).toBe(200);
  expect((await editable.json()).data).toMatchObject({
    member_id: p.id,
    snapshot: current.snapshot,
    history_total: 0,
  });
  expect(
    (
      await PATCH(
        new Request(url, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        context,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await PATCH(
        new Request(url, {
          method: "PATCH",
          headers: {
            cookie,
            origin: "https://unrelated.example",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        context,
      )
    ).status,
  ).toBe(403);
  for (const invalid of [
    { ...body, actor: "imposter" },
    { ...body, changes: { price: "1" } },
    {
      ...body,
      changes: {
        brand: "x".repeat(settings.product_details.value_max_length + 1),
      },
    },
  ]) {
    expect(
      (
        await PATCH(
          new Request(url, {
            method: "PATCH",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify(invalid),
          }),
          context,
        )
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await PATCH(
        new Request(url, {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        context,
      )
    ).status,
  ).toBe(200);
  expect((await read(p.group_id, p.id))!.history[0].actor).toBe(
    settings.auth.username,
  );
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

async function recordCategory(
  id: string,
  family: Family = "soft_drinks",
  selected: Family = family,
  probability = 0.97,
) {
  const product = await getProduct(id);
  await pool.query(
    "INSERT INTO matching_prompt_versions(key,files) VALUES('detail-category-test','[]') ON CONFLICT DO NOTHING",
  );
  await saveClassification(product, {
    key: classificationRequest(product).key,
    family,
    hints: [],
    model: "test-decision-model",
    prompt_key: "detail-category-test",
    selected,
    probabilities: { [selected]: probability },
    confidence: 0.02,
    generation_id: "detail-category-generation",
  });
}
it("includes a not-categorized state in product details without calling AI", async () => {
  const product = await publish("kam");
  expect(
    (await detailsForProduct(product.group_id))?.listings[0].classification,
  ).toMatchObject({
    state: "not_categorized",
    category: null,
    suggested_category: null,
    probability: null,
    threshold: null,
  });
  expect(fetch).not.toHaveBeenCalled();
});
it("shows each store product’s saved category with its selected probability rather than provider confidence", async () => {
  const kam = await publish("kam"),
    spar = await publish("spar");
  await recordCategory(kam.id);
  await recordCategory(spar.id, "unknown", "other_food", 0.62);
  await pool.query("UPDATE store_products SET group_id=$2 WHERE id=$1", [
    spar.id,
    kam.group_id,
  ]);
  const detail = (await detailsForProduct(kam.group_id))!;
  expect(
    detail.listings.find((row) => row.retailer === "kam")?.classification,
  ).toMatchObject({
    state: "assigned",
    category: "soft_drinks",
    suggested_category: "soft_drinks",
    probability: 0.97,
    threshold: 0.8,
  });
  expect(
    detail.listings.find((row) => row.retailer === "spar")?.classification,
  ).toMatchObject({
    state: "uncertain",
    category: "unknown",
    suggested_category: "other_food",
    probability: 0.62,
    threshold: 0.8,
  });
  expect(fetch).not.toHaveBeenCalled();
});
it("retains the category for unavailable products and marks it outdated after a manual detail change", async () => {
  const product = await publish("kam");
  await recordCategory(product.id);
  await pool.query("UPDATE sources SET active=false WHERE retailer='kam'");
  expect(
    (await detailsForProduct(product.group_id))?.listings[0].classification
      ?.state,
  ).toBe("assigned");
  await edit((await read(product.group_id, product.id))!, {
    brand: "Corrected brand",
  });
  expect(
    (await detailsForProduct(product.group_id))?.listings[0].classification,
  ).toMatchObject({
    state: "outdated",
    category: "soft_drinks",
    probability: 0.97,
  });
  expect(
    (await pool.query("SELECT * FROM store_product_classifications")).rowCount,
  ).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});
