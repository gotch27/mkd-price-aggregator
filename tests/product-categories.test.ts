import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
import {
  readCategory,
  saveCategory,
} from "@/nextsignal/services/product-categories";
import { detailsForProduct } from "@/nextsignal/services/product-browser";
import {
  read as readDetails,
  save as saveDetails,
} from "@/nextsignal/services/product-details";
import {
  readSettings,
  saveSettings,
} from "@/nextsignal/services/task-settings";
import {
  createTask,
  executeTask,
  categoryCounts,
} from "@/nextsignal/services/tasks";
import { taskResults } from "@/nextsignal/services/task-results";
import type { CatalogRow } from "@/nextsignal/domain/types";
import { families, type StoreProduct } from "@/nextsignal/domain/matching";

beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await pool.query(
    "TRUNCATE retailers,products,runs,sources,listings,ai_cache,ai_usage,operational_settings,operational_settings_history,task_executions CASCADE",
  );
  await seedRetailers();
  await readSettings();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Category edits must not call AI");
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.end();
});
async function publish(
  branch = "one",
  name = "Coca Cola Original 330 ml can",
  price = "40.00",
) {
  const source = (
    await pool.query(
      `INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES('kam',$1,$1,$2,'branch','{}') ON CONFLICT(retailer,external_id) DO UPDATE SET active=true RETURNING id`,
      [branch, settings.sources.kam.url],
    )
  ).rows[0].id;
  const row: CatalogRow = {
    key: "cola",
    name,
    description: null,
    category: "Drinks",
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
  const run = await createRun("catalog", "kam", source, null);
  await stagePage(run, { rows: [row], next: null, total: 1, artifact: null });
  await publishCatalog(await getRun(run.id));
  const id = (
    await pool.query(
      "SELECT store_product_id FROM store_product_aliases WHERE source_id=$1",
      [source],
    )
  ).rows[0].store_product_id;
  return getProduct(id);
}
async function model(product: StoreProduct) {
  const current = await getProduct(product.id);
  await pool.query(
    "INSERT INTO matching_prompt_versions(key,files) VALUES('manual-category-test','[]') ON CONFLICT DO NOTHING",
  );
  const answer = {
    key: classificationRequest(current).key,
    family: "unknown" as const,
    hints: [],
    model: "mock-decider",
    prompt_key: "manual-category-test",
    selected: "soft_drinks",
    probabilities: { soft_drinks: 0.62, other_food: 0.38 },
    confidence: 0.99,
    generation_id: "category-test-generation",
  };
  await saveClassification(current, answer);
  return answer;
}
async function change(
  product: StoreProduct,
  action: "set" | "accept_suggestion" | "reset" = "set",
  category = "soft_drinks",
) {
  const view = (await readCategory(product.group_id, product.id))!;
  const result = await saveCategory(
    {
      id: view.id,
      member_id: view.member_id,
      snapshot: view.classification.snapshot,
      action,
      category: action === "set" ? category : null,
      note: "Verified by a person",
    },
    "reviewer",
  );
  if (!result.ok) throw new Error(result.reason);
  return result;
}

it("sets an uncategorized product manually with AI off and records actor, history and logs", async () => {
  const product = await publish();
  expect((await readSettings()).policy.ai_enabled).toBe(false);
  await change(product);
  const saved = await getProduct(product.id);
  expect(saved).toMatchObject({
    manual_family: "soft_drinks",
    classified_family: "soft_drinks",
    family: "soft_drinks",
  });
  expect(
    (await detailsForProduct(product.group_id))?.listings[0].classification,
  ).toMatchObject({
    state: "manual",
    category: "soft_drinks",
    manual_category: "soft_drinks",
  });
  const view = (await readCategory(product.group_id, product.id))!;
  expect(view.history_total).toBe(1);
  expect(view.history[0]).toMatchObject({
    actor: "reviewer",
    action: "set",
    before_category: null,
    after_category: "soft_drinks",
  });
  expect(
    (
      await pool.query(
        "SELECT data FROM logs WHERE data->>'event'='products.category.updated' AND data->>'member_id'=$1",
        [product.id],
      )
    ).rows[0].data,
  ).toMatchObject({ actor: "reviewer", before: null, after: "soft_drinks" });
  expect((await pool.query("SELECT * FROM task_executions")).rowCount).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("approves a low-probability suggestion without changing the threshold or rewriting the AI answer", async () => {
  const product = await publish();
  await model(product);
  expect(
    (await readCategory(product.group_id, product.id))?.classification,
  ).toMatchObject({
    state: "uncertain",
    can_accept_suggestion: true,
    probability: 0.62,
    threshold: 0.8,
  });
  await change(product, "accept_suggestion");
  expect(await getProduct(product.id)).toMatchObject({
    manual_family: "soft_drinks",
    classified_family: "soft_drinks",
  });
  expect(
    (
      await pool.query(
        "SELECT family,probability FROM store_product_classifications",
      )
    ).rows,
  ).toEqual([{ family: "unknown", probability: "0.62" }]);
  expect((await readSettings()).policy.category_threshold).toBe(0.8);
  expect(
    (await readCategory(product.group_id, product.id))?.history[0].action,
  ).toBe("accept_suggestion");
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves manual categories through price imports, branch copies, detail edits and deliberate rechecks without AI", async () => {
  const product = await publish();
  await change(product);
  await publish("one", product.name, "55.00");
  await publish("two", product.name, "60.00");
  const editable = (await readDetails(product.group_id, product.id))!;
  expect(
    (
      await saveDetails(
        {
          id: editable.id,
          member_id: editable.member_id,
          snapshot: editable.snapshot,
          action: "update",
          changes: { brand: "Corrected brand" },
          note: "",
        },
        "reviewer",
      )
    ).ok,
  ).toBe(true);
  expect(await getProduct(product.id)).toMatchObject({
    manual_family: "soft_drinks",
    classified_family: "soft_drinks",
  });
  const settingsBefore = await readSettings();
  const allowed = await saveSettings(
    settingsBefore.revision,
    { ...settingsBefore.policy, ai_enabled: true },
    "reviewer",
  );
  const task = await createTask(
    {
      revision: allowed.revision,
      kind: "categorize",
      retailers: ["kam"],
      source_id: null,
      product_limit: 1,
      use_ai: true,
      categories: [],
      max_cost_usd: 0.1,
      recheck: true,
      idempotency_key: randomUUID(),
    },
    "reviewer",
  );
  await executeTask(task.id);
  const result = (await taskResults({
    id: task.id,
    page: 1,
    size: 10,
    search: "",
    category: "",
    outcome: "",
  }))!;
  expect(result.rows[0]).toMatchObject({
    source: "manual",
    outcome: "assigned",
    assigned_category: "soft_drinks",
    probability: null,
  });
  expect((await pool.query("SELECT * FROM ai_usage")).rowCount).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects stale approvals and prevents late or newly proposed AI decisions from replacing a manual choice", async () => {
  const product = await publish();
  const answer = await model(product);
  const old = (await readCategory(product.group_id, product.id))!;
  await change(product, "set", "cleaning");
  const stale = await saveCategory(
    {
      id: product.group_id,
      member_id: product.id,
      snapshot: old.classification.snapshot,
      action: "accept_suggestion",
      category: null,
      note: "",
    },
    "reviewer",
  );
  expect(stale.ok).toBe(false);
  expect(
    await saveClassification(await getProduct(product.id), {
      ...answer,
      family: "dairy",
      selected: "dairy",
      probabilities: { dairy: 1 },
    }),
  ).toBeNull();
  expect(await getProduct(product.id)).toMatchObject({
    manual_family: "cleaning",
    classified_family: "cleaning",
  });
  expect(
    (await readCategory(product.group_id, product.id))?.history_total,
  ).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});

it("can remove a manual choice, restoring a current AI answer or waiting for recategorization when source details changed", async () => {
  const product = await publish();
  await model(product);
  await change(product, "accept_suggestion");
  await change(product, "reset");
  expect(await getProduct(product.id)).toMatchObject({
    manual_family: null,
    classified_family: "unknown",
  });
  expect(
    (await readCategory(product.group_id, product.id))?.classification.state,
  ).toBe("uncertain");
  await change(product);
  const editable = (await readDetails(product.group_id, product.id))!;
  await saveDetails(
    {
      id: editable.id,
      member_id: editable.member_id,
      snapshot: editable.snapshot,
      action: "update",
      changes: { brand: "Changed source interpretation" },
      note: "",
    },
    "reviewer",
  );
  await change(product, "reset");
  expect(await getProduct(product.id)).toMatchObject({
    manual_family: null,
    classified_family: null,
  });
  expect(
    (
      await pool.query(
        "SELECT category_pending FROM store_products WHERE id=$1",
        [product.id],
      )
    ).rows[0].category_pending,
  ).toBe(true);
  expect(
    (await readCategory(product.group_id, product.id))?.classification
      .can_accept_suggestion,
  ).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it("does not copy an old manual choice to a genuinely different product revision", async () => {
  const product = await publish();
  await change(product);
  const replacement = await publish("one", "Coca Cola Original 500 ml can");
  expect(replacement.id).not.toBe(product.id);
  expect(replacement.manual_family).toBeNull();
  expect((await getProduct(product.id)).manual_family).toBe("soft_drinks");
  expect(fetch).not.toHaveBeenCalled();
});

it("protects category edits with authentication, origin validation, allowed labels and saved snapshots", async () => {
  const product = await publish();
  const { GET, PATCH } = await import("@/app/api/products/[id]/category/route");
  const { SESSION_COOKIE, sessionToken } =
    await import("@/nextsignal/adapters/auth");
  const origin = settings.auth.allowed_origins[0],
    url = new URL(
      `/api/products/${product.group_id}/category?member_id=${product.id}`,
      origin,
    ),
    context = { params: Promise.resolve({ id: product.group_id }) };
  expect((await GET(new Request(url), context)).status).toBe(401);
  const headers = {
    cookie: `${SESSION_COOKIE}=${sessionToken()}`,
    origin,
    "content-type": "application/json",
  };
  const view = (
    await (await GET(new Request(url, { headers }), context)).json()
  ).data;
  const body = {
    member_id: product.id,
    snapshot: view.classification.snapshot,
    action: "set",
    category: "soft_drinks",
    note: "Human verification",
  };
  expect(
    (
      await PATCH(
        new Request(url, {
          method: "PATCH",
          headers: { ...headers, origin: "https://foreign.example" },
          body: JSON.stringify(body),
        }),
        context,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await PATCH(
        new Request(url, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ ...body, category: "invalid" }),
        }),
        context,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await PATCH(
        new Request(url, {
          method: "PATCH",
          headers,
          body: JSON.stringify(body),
        }),
        context,
      )
    ).status,
  ).toBe(200);
  expect(
    (await readCategory(product.group_id, product.id))?.history[0].actor,
  ).toBe(settings.auth.username);
  expect(fetch).not.toHaveBeenCalled();
});

it("marks an uncertain task result reviewed without rewriting its original model answer or making another call", async () => {
  const product = await publish();
  const initial = await readSettings();
  const allowed = await saveSettings(
    initial.revision,
    { ...initial.policy, ai_enabled: true },
    "reviewer",
  );
  const request = vi.fn(async () =>
    Response.json({
      answers: {
        family: {
          type: "choice",
          choice: "soft_drinks",
          probabilities: Object.fromEntries(
            families.map((f) => [
              f,
              f === "soft_drinks" ? 0.62 : 0.38 / (families.length - 1),
            ]),
          ),
          confidence: 0.99,
        },
      },
      usage: { inputTokens: 10, outputTokens: 0 },
      providerMetadata: {
        gateway: { cost: "0.000001", generationId: randomUUID() },
      },
    }),
  );
  vi.stubGlobal("fetch", request);
  const task = await createTask(
    {
      revision: allowed.revision,
      kind: "categorize",
      retailers: ["kam"],
      source_id: null,
      product_limit: 1,
      use_ai: true,
      categories: [],
      max_cost_usd: 0.1,
      recheck: false,
      idempotency_key: randomUUID(),
    },
    "reviewer",
  );
  await executeTask(task.id);
  const snapshot = (
    await pool.query("SELECT result FROM task_items WHERE task_id=$1", [
      task.id,
    ])
  ).rows[0].result;
  const query = {
    id: task.id,
    page: 1,
    size: 10,
    search: "",
    category: "",
    outcome: "",
  };
  expect((await taskResults(query))?.summary).toMatchObject({
    needs_review: 1,
    reviewed: 0,
  });
  await change(product, "accept_suggestion");
  const results = (await taskResults(query))!;
  expect(results.summary).toMatchObject({ needs_review: 0, reviewed: 1 });
  expect(results.rows[0]).toMatchObject({
    manual_category: "soft_drinks",
    assigned_category: "unknown",
    outcome: "uncertain",
    probability: 0.62,
  });
  expect((await taskResults({ ...query, outcome: "reviewed" }))?.total).toBe(1);
  expect(
    (await taskResults({ ...query, outcome: "needs_review" }))?.total,
  ).toBe(0);
  expect(
    (await taskResults({ ...query, category: "soft_drinks" }))?.total,
  ).toBe(1);
  expect(
    (
      await pool.query("SELECT result FROM task_items WHERE task_id=$1", [
        task.id,
      ])
    ).rows[0].result,
  ).toEqual(snapshot);
  expect((await categoryCounts("kam", "")).counts).toEqual([
    { family: "soft_drinks", count: 1 },
  ]);
  expect(request).toHaveBeenCalledTimes(1);
});

it("returns ranked saved label probabilities and a snapshot usable to undo a manual review", async () => {
  const product = await publish();
  await model(product);
  const before = (await readCategory(product.group_id, product.id))!
    .classification;
  expect(before.options.slice(0, 2)).toEqual([
    { category: "soft_drinks", label: "Soft drinks", probability: 0.62 },
    { category: "other_food", label: "Other food", probability: 0.38 },
  ]);
  expect(before.options).toHaveLength(families.length);
  expect(
    before.options.find((o) => o.category === "fruit")?.probability,
  ).toBeNull();
  const confirmed = await change(product, "accept_suggestion");
  expect(confirmed.classification).toMatchObject({
    state: "manual",
    category: "soft_drinks",
  });
  expect(confirmed.classification.snapshot).not.toBe(before.snapshot);
  const restored = await saveCategory(
    {
      id: product.group_id,
      member_id: product.id,
      snapshot: confirmed.classification.snapshot,
      action: "reset",
      category: null,
      note: "Undo manual review choice",
    },
    "reviewer",
  );
  expect(restored.ok).toBe(true);
  expect(
    (await readCategory(product.group_id, product.id))!.classification,
  ).toMatchObject({
    state: "uncertain",
    can_accept_suggestion: true,
    probability: 0.62,
  });
  expect(
    (
      await pool.query(
        "SELECT actor,action FROM product_category_edits ORDER BY created_at",
      )
    ).rows,
  ).toEqual([
    { actor: "reviewer", action: "accept_suggestion" },
    { actor: "reviewer", action: "reset" },
  ]);
  expect(fetch).not.toHaveBeenCalled();
});

it("does not let Undo overwrite a newer choice by another person", async () => {
  const product = await publish();
  await model(product);
  const first = await change(product, "accept_suggestion");
  await change(product, "set", "alcohol");
  const undo = await saveCategory(
    {
      id: product.group_id,
      member_id: product.id,
      snapshot: first.classification.snapshot,
      action: "reset",
      category: null,
      note: "Undo",
    },
    "reviewer",
  );
  expect(undo.ok).toBe(false);
  expect((await getProduct(product.id)).manual_family).toBe("alcohol");
  expect(
    (await pool.query("SELECT count(*)::int total FROM product_category_edits"))
      .rows[0].total,
  ).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
});
