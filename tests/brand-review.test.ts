import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import { getProduct } from "@/nextsignal/services/matching-repository";
import { classificationRequest } from "@/nextsignal/services/ai-gateway";
import {
  readSettings,
  saveSettings,
} from "@/nextsignal/services/task-settings";
import * as review from "@/nextsignal/services/brand-review";
import * as brands from "@/nextsignal/services/brands";
import { refreshBatch } from "@/nextsignal/services/brand-facts";
import type {
  BrandReviewDecision,
  BrandReviewItem,
  BrandReviewSession,
} from "@/nextsignal/domain/brand-review";
import type { Retailer } from "@/nextsignal/domain/types";

const actor = "brand-tester",
  created = new Set<string>();
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  await pool.query(
    "TRUNCATE brand_review_sessions,brand_fact_refresh,retailers,products,runs,sources,operational_settings,operational_settings_history,task_executions,ai_cache,ai_usage CASCADE",
  );
  if (created.size) {
    await pool.query("DELETE FROM brand_edits WHERE brand_id=ANY($1::uuid[])", [
      [...created],
    ]);
    await pool.query(
      "DELETE FROM brand_aliases WHERE brand_id=ANY($1::uuid[])",
      [[...created]],
    );
    await pool.query("DELETE FROM brands WHERE id=ANY($1::uuid[])", [
      [...created],
    ]);
    created.clear();
  }
  await seedRetailers();
  await readSettings();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Brand review must not call providers");
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.query(
    "TRUNCATE brand_review_sessions,brand_fact_refresh,retailers,products,runs,sources CASCADE",
  );
  await pool.query("DELETE FROM brand_edits WHERE brand_id=ANY($1::uuid[])", [
    [...created],
  ]);
  await pool.query("DELETE FROM brand_aliases WHERE brand_id=ANY($1::uuid[])", [
    [...created],
  ]);
  await pool.query("DELETE FROM brands WHERE id=ANY($1::uuid[])", [
    [...created],
  ]);
  await pool.end();
});
async function publish(
  retailer: Retailer,
  name = "Zaffiro yogurt 150g",
  description: string | null = null,
  available = true,
) {
  const source = (
    await pool.query(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,'Brand fixture',$3,'retailer','{}') RETURNING id",
      [retailer, randomUUID(), settings.sources[retailer].url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", retailer, source, null);
  await stagePage(run, {
    rows: [
      {
        key: "one",
        name,
        description,
        category: null,
        gtin: null,
        price: "30.00",
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
  return (
    await pool.query(
      "SELECT sp.id FROM store_products sp JOIN store_product_sources ss ON ss.store_product_id=sp.id WHERE ss.source_id=$1",
      [source],
    )
  ).rows[0].id as string;
}
const start = (
  extra: Partial<Parameters<typeof review.startSession>[0]> = {},
) =>
  review.startSession(
    {
      request_id: randomUUID(),
      limit: 50,
      search: "",
      reviewer: "agent",
      agent_name: "Codex",
      agent_model: "test-model",
      include_previously_skipped: false,
      ...extra,
    },
    actor,
  );
function choice(item: BrandReviewItem, global = false): BrandReviewDecision {
  const examples = global ? item.examples : [item.examples[0]];
  return {
    item_id: item.id,
    snapshot: item.input_key,
    action: "save",
    brand_id: null,
    brand_revision: null,
    name: "Zaffiro",
    aliases: [
      {
        name: examples[0].quote,
        retailer: global ? null : examples[0].retailer,
        evidence: examples.map((e) => ({
          member_id: e.id,
          field: e.field,
          quote: e.quote,
        })),
      },
    ],
    reason: "Source examples explicitly name this brand",
  };
}
async function submit(
  s: BrandReviewSession,
  decisions: BrandReviewDecision[],
  request_id = randomUUID(),
) {
  const result = await review.submitBatch(
    { id: s.id, request_id, reviewer: s.options.reviewer, decisions },
    actor,
  );
  for (const r of result.results) if (r.brand_id) created.add(r.brand_id);
  return result;
}
const group = (s: BrandReviewSession, term = "zaffiro") => {
  const item = s.results.find((r) => r.term === term);
  if (!item) throw new Error(`Missing group ${term}`);
  return item;
};

it("reads quietly with AI off and freezes only available, scoped unique products", async () => {
  await publish("kam");
  await publish("spar");
  await publish("vero", "Zaffiro yogurt 150g", null, false);
  const before = await readSettings(),
    context = await review.readContext(actor);
  expect(context.session).toBeNull();
  expect(context.limits).toMatchObject({ default_groups: 50, batch_size: 10 });
  const s = await start({ retailer: "kam", limit: 1 });
  expect(s.total).toBe(1);
  expect(s.results[0].examples.every((e) => e.retailer === "kam")).toBe(true);
  expect((await readSettings()).revision).toBe(before.revision);
  expect(fetch).not.toHaveBeenCalled();
  expect(
    (await pool.query("SELECT count(*)::int n FROM task_executions")).rows[0].n,
  ).toBe(0);
});
it("saves source-backed global aliases idempotently, audits Agent and refreshes only local brand facts", async () => {
  const a = await publish("kam"),
    b = await publish("spar");
  const p = await getProduct(a),
    key = (await classificationRequest(p)).key;
  const offers = (
    await pool.query("SELECT count(*)::int n FROM store_product_sources")
  ).rows[0].n;
  const s = await start(),
    item = group(s),
    id = randomUUID(),
    decision = choice(item, true);
  const result = await submit(s, [decision], id);
  expect(group(result).state).toBe("saved");
  const brandId = group(result).brand_id!;
  expect(await submit(s, [decision], id)).toEqual(result);
  expect(
    (
      await pool.query(
        "SELECT source,reason,session_id FROM brand_edits WHERE brand_id=$1",
        [brandId],
      )
    ).rows[0],
  ).toMatchObject({
    source: "agent",
    session_id: s.id,
    reason: decision.reason,
  });
  for (const productId of [a, b])
    expect(
      (
        await pool.query("SELECT brand_id FROM store_products WHERE id=$1", [
          productId,
        ])
      ).rows[0].brand_id,
    ).toBe(brandId);
  expect((await getProduct(a)).group_id).toBe(p.group_id);
  expect((await classificationRequest(await getProduct(a))).key).toBe(key);
  expect(
    (await pool.query("SELECT count(*)::int n FROM store_product_sources"))
      .rows[0].n,
  ).toBe(offers);
  expect(
    (await pool.query("SELECT count(*)::int n FROM ai_usage")).rows[0].n,
  ).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  await expect(
    review.submitBatch(
      {
        id: s.id,
        request_id: randomUUID(),
        reviewer: "human",
        decisions: [decision],
      },
      actor,
    ),
  ).rejects.toThrow("correct Human or Agent");
  await expect(review.readBatch(s.id, "other-account")).rejects.toThrow(
    "not found",
  );
});
it("rejects unsupported evidence, global aliases from one store, stale snapshots and manual brand changes", async () => {
  const p = await publish("kam"),
    s = await start(),
    item = group(s);
  const invalid = choice(item);
  invalid.aliases[0].evidence[0].quote = "Invented";
  const r = await submit(s, [invalid]);
  expect(group(r)).toMatchObject({ state: "rejected" });
  expect(group(r).reason).toContain("exact original");
  await review.control(s.id, actor, "stop");
  const second = await start(),
    g = group(second),
    global = choice(g, true);
  expect(group(await submit(second, [global])).reason).toContain("two stores");
  await review.control(second.id, actor, "stop");
  const third = await start(),
    t = group(third);
  await pool.query(
    "UPDATE store_products SET manual_facts=jsonb_build_object('brand',NULL) WHERE id=$1",
    [p],
  );
  expect(group(await submit(third, [choice(t)])).reason).toContain(
    "human brand correction",
  );
});
it("remembers skips across sessions but permits an explicit retry", async () => {
  await publish("kam");
  const s = await start();
  const skipped = group(s),
    d: BrandReviewDecision = {
      ...choice(skipped),
      action: "skip",
      brand_id: null,
      brand_revision: null,
      name: null,
      aliases: [],
      reason: "Not enough evidence that this term is a brand",
    };
  await submit(s, [d]);
  await review.control(s.id, actor, "stop");
  expect((await start()).total).toBe(0);
  expect(
    (await start({ include_previously_skipped: true })).total,
  ).toBeGreaterThan(0);
});
it("undo restores aliases and product brand facts, while later human corrections survive", async () => {
  const a = await publish("kam"),
    b = await publish("spar"),
    s = await start();
  const r = await submit(s, [choice(group(s), true)]),
    brandId = group(r).brand_id!;
  await pool.query(
    "UPDATE store_products SET manual_facts=jsonb_build_object('brand','Human'),facts=jsonb_set(facts,'{brand}',jsonb_build_object('value','Human','quote','Human','source','manual','method','manual')) WHERE id=$1",
    [b],
  );
  await review.control(s.id, actor, "undo", "human");
  expect(
    (await pool.query("SELECT active FROM brands WHERE id=$1", [brandId]))
      .rows[0].active,
  ).toBe(false);
  expect((await getProduct(a)).facts.brand).toBeUndefined();
  expect((await getProduct(b)).facts.brand?.value).toBe("Human");
  await review.control(s.id, actor, "stop");
  await review.control(s.id, actor, "acknowledge");
  expect(
    (await review.readContext(actor)).session?.acknowledged_at,
  ).not.toBeNull();
});
it("preserves a newer dictionary edit on undo and pauses bounded local refresh jobs", async () => {
  const a = await publish("kam"),
    s = await start(),
    settingsBefore = await readSettings();
  await saveSettings(
    settingsBefore.revision,
    { ...settingsBefore.policy, paused: true },
    actor,
  );
  const r = await submit(s, [choice(group(s))]),
    brandId = group(r).brand_id!;
  expect((await getProduct(a)).facts.brand).toBeUndefined();
  expect((await review.readContext(actor)).refresh_pending).toBe(1);
  const brand = (await brands.list("Zaffiro", 1, 10)).rows.find(
    (b) => b.id === brandId,
  )!;
  await brands.save(
    { name: "Zaffiro edited", aliases: brand.aliases },
    "human",
    brand.id,
    brand.revision,
  );
  expect(
    group(await review.control(s.id, actor, "undo", "human")).undo_status,
  ).toBe("changed");
  const live = await readSettings();
  await saveSettings(live.revision, { ...live.policy, paused: false }, actor);
  await refreshBatch();
  expect(
    (await pool.query("SELECT brand_id FROM store_products WHERE id=$1", [a]))
      .rows[0].brand_id,
  ).toBe(brandId);
});
it("refreshes a description-only source alias and preserves an explicitly cleared brand", async () => {
  const a = await publish("kam", "Yogurt 150g", "Zaffiro yogurt"),
    b = await publish("spar", "Yogurt 150g", "Zaffiro yogurt");
  await pool.query(
    "UPDATE store_products SET manual_facts=jsonb_build_object('brand',NULL) WHERE id=$1",
    [b],
  );
  const brand = await brands.save(
    { name: "Zaffiro", aliases: [{ name: "Zaffiro", retailer: "kam" }] },
    actor,
  );
  created.add(brand.id);
  expect(
    (await pool.query("SELECT brand_id FROM store_products WHERE id=$1", [a]))
      .rows[0].brand_id,
  ).toBe(brand.id);
  expect(
    (await pool.query("SELECT brand_id FROM store_products WHERE id=$1", [b]))
      .rows[0].brand_id,
  ).toBeNull();
});
it("accepts several spellings of one new brand in a batch and undoes them in revision order", async () => {
  await publish("kam", "Zaffiro yogurt 150g");
  await publish("spar", "Zafiro yogurt 150g");
  const s = await start(),
    left = group(s, "zaffiro"),
    right = group(s, "zafiro");
  const a = choice(left),
    b = choice(right);
  a.name = b.name = "Zaffiro";
  const result = await submit(s, [b, a]);
  expect(result.saved).toBe(2);
  const id = group(result, "zaffiro").brand_id!;
  expect(group(result, "zafiro").brand_id).toBe(id);
  expect(
    (await brands.list("Zaffiro", 1, 10)).rows.find((b) => b.id === id)
      ?.aliases,
  ).toHaveLength(2);
  await review.control(s.id, actor, "undo", "human");
  expect(
    (await pool.query("SELECT active FROM brands WHERE id=$1", [id])).rows[0]
      .active,
  ).toBe(false);
  while ((await review.readContext(actor)).refresh_pending)
    await refreshBatch();
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM store_products WHERE brand_id=$1",
        [id],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("keeps a store-scoped alias from silently matching canonical spellings in other stores", async () => {
  const a = await publish("kam"),
    b = await publish("spar"),
    s = await start();
  const decision = choice(group(s));
  decision.aliases[0].retailer = "kam";
  decision.aliases[0].evidence = group(s)
    .examples.filter((e) => e.retailer === "kam")
    .map((e) => ({ member_id: e.id, field: e.field, quote: e.quote }));
  const saved = await submit(s, [decision]),
    id = group(saved).brand_id!;
  expect(
    (await pool.query("SELECT brand_id FROM store_products WHERE id=$1", [a]))
      .rows[0].brand_id,
  ).toBe(id);
  expect(
    (await pool.query("SELECT brand_id FROM store_products WHERE id=$1", [b]))
      .rows[0].brand_id,
  ).toBeNull();
});

it("filters generic terms and never restores a stop word as a fallback", async () => {
  await publish("spar", "[AMPON @ENSKI PVC 400ML");
  await publish("vero", "ЖЕНСКИ ЧОРАПИ");
  await publish("kam", "ЛЕБ ВИНО СЛАДОЛЕД");
  await publish("ramstore", "ТЕЧЕН САПУН КРЕМА ПЕШКИР 50 ЦМ");
  await publish("zito", "ШАМПОН Zaffiro 400МЛ");
  const session = await start();
  expect(session.results.map((g) => g.term)).toEqual(["zaffiro"]);
  expect(session.results[0].examples[0].quote).toBe("Zaffiro");
  expect(fetch).not.toHaveBeenCalled();
});
