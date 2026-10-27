import { beforeEach, afterEach, afterAll, it, expect, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import { refreshProductTextIndex } from "@/nextsignal/services/product-text-index";
import { readDashboard } from "@/nextsignal/services/dashboard-read";
import { getProduct } from "@/nextsignal/services/matching-repository";
import { classificationRequest } from "@/nextsignal/services/ai-gateway";
import { normalizeName, hash } from "@/nextsignal/domain/normalize";
import type { Retailer } from "@/nextsignal/domain/types";

beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  await pool.query(
    "TRUNCATE retailers,sources,runs,listings,products,logs,ai_usage CASCADE",
  );
  await seedRetailers();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected external call");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => pool.end());
async function publish(retailer: Retailer, name: string) {
  const s = (
    await pool.query(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,'text-test','Text test',$2,'branch','{}') RETURNING id",
      [retailer, settings.sources[retailer].url],
    )
  ).rows[0];
  const run = await createRun("catalog", retailer, s.id, null);
  await stagePage(run, {
    rows: [
      {
        key: "item",
        name,
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
      },
    ],
    next: null,
    total: 1,
    artifact: null,
  });
  await publishCatalog(await getRun(run.id));
  return (
    await pool.query("SELECT * FROM store_products WHERE retailer=$1", [
      retailer,
    ])
  ).rows[0];
}
it("repairs only derived fields, preserving source rows, IDs, saved category/match memory and prices", async () => {
  const p = await publish("spar", "SIREWE KRAVJO 500GR");
  await pool.query(
    "UPDATE store_products SET normalized_name='stale',facts='{}',family='unknown',local_key=NULL WHERE id=$1",
    [p.id],
  );
  const before = (
    await pool.query("SELECT * FROM store_products WHERE id=$1", [p.id])
  ).rows[0];
  const listings = (await pool.query("SELECT * FROM listings ORDER BY id"))
    .rows;
  const offers = (
    await pool.query("SELECT * FROM offers ORDER BY listing_id,source_id")
  ).rows;
  expect(await refreshProductTextIndex()).toMatchObject({
    scanned: 1,
    updated: 1,
    stale: 0,
  });
  const after = (
    await pool.query("SELECT * FROM store_products WHERE id=$1", [p.id])
  ).rows[0];
  for (const key of Object.keys(before).filter(
    (k) => !["normalized_name", "facts", "family", "local_key"].includes(k),
  ))
    expect(after[key]).toEqual(before[key]);
  expect(after.normalized_name).toBe("sirenje kravjo 500gr");
  expect(after.facts.type.value).toBe("cheese");
  expect((await pool.query("SELECT * FROM listings ORDER BY id")).rows).toEqual(
    listings,
  );
  expect(
    (await pool.query("SELECT * FROM offers ORDER BY listing_id,source_id"))
      .rows,
  ).toEqual(offers);
  expect(await refreshProductTextIndex()).toMatchObject({
    scanned: 1,
    updated: 0,
    stale: 0,
  });
  expect(
    (await pool.query("SELECT count(*)::int n FROM ai_usage")).rows[0].n,
  ).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it("finds a product by both its source spelling and readable Cyrillic after publication", async () => {
  const p = await publish("spar", "SIREWE KRAVJO 500GR");
  for (const search of ["SIREWE", "СИРЕЊЕ"]) {
    const result = await readDashboard({
      view: "products",
      search,
      page: 1,
      size: 30,
      retailer: "spar",
    });
    expect(
      "rows" in result && result.rows.map((r) => r.store_product_id),
    ).toContain(p.id);
  }
  const saved = await getProduct(p.id);
  expect(saved!.name).toBe("SIREWE KRAVJO 500GR");
  const request = classificationRequest(saved!);
  expect(request.state.product.name).toBe(saved!.name);
  expect(request.state.product.readable_name).toBe("СИРЕЊЕ КРАВЈО 500GR");
  expect(fetch).not.toHaveBeenCalled();
});
it("does not reset a saved classification or manual correction during search repair", async () => {
  const p = await publish("kam", "МЛЕКО БИТОЛСКО 1Л");
  await pool.query(
    "UPDATE store_products SET classified_family='dairy',classification_key='saved-decision',manual_facts=$2,normalized_name='stale' WHERE id=$1",
    [p.id, JSON.stringify({ brand: "Reviewed brand" })],
  );
  await refreshProductTextIndex();
  const saved = (
    await pool.query("SELECT * FROM store_products WHERE id=$1", [p.id])
  ).rows[0];
  expect(saved.classification_key).toBe("saved-decision");
  expect(saved.classified_family).toBe("dairy");
  expect(saved.manual_facts.brand).toBe("Reviewed brand");
  expect(saved.facts.brand.method).toBe("manual");
  expect(saved.normalized_name).toBe(normalizeName(p.name));
  expect(fetch).not.toHaveBeenCalled();
});
it("adds readable interpretation without expiring a saved category for the same source and prompt", async () => {
  const p = await publish("kam", "ВРАТ СВИНСКИ 1 КГ");
  const input = {
    ...(await getProduct(p.id))!,
    description: "DOMA[NO ВРАТ СВИНСКИ",
    category: "DOMA[NO ВРАТ СВИНСКИ",
  };
  const plan = classificationRequest(input);
  expect(plan.state.product.readable_description).toBe("ДОМАШНО ВРАТ СВИНСКИ");
  const priorState = {
    product: {
      store: "kam",
      name: input.name,
      readable_name: input.name,
      description: input.description,
      category: input.category,
      family: "unknown",
      facts: { quantity: "1000", unit: "g" },
    },
  };
  const priorKey = hash([
    settings.matching.gateway.base_url,
    settings.matching.gateway.decision_model,
    priorState,
    plan.questions,
    plan.prompt.key,
  ]);
  expect(plan.key).toBe(priorKey);
  expect(hash(plan.state)).not.toBe(hash(priorState));
  expect(fetch).not.toHaveBeenCalled();
});
