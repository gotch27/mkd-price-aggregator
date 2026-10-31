import { randomUUID } from "node:crypto";
import { beforeEach, afterAll, it, expect, vi } from "vitest";
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
  readSettings,
  saveSettings,
} from "@/nextsignal/services/task-settings";
import {
  createTask,
  executeTask,
  pendingProductContinuation,
} from "@/nextsignal/services/tasks";
import {
  classificationViews,
  saveCategory,
} from "@/nextsignal/services/product-categories";
import { readQueue } from "@/nextsignal/services/category-review";
import { taskResults } from "@/nextsignal/services/task-results";
import { families } from "@/nextsignal/domain/matching";

beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  await pool.query(
    "TRUNCATE gateway_cooldown,retailers,products,runs,sources,listings,ai_cache,ai_usage,operational_settings,operational_settings_history,task_executions CASCADE",
  );
  await seedRetailers();
  const current = await readSettings();
  await saveSettings(
    current.revision,
    { ...current.policy, ai_enabled: true, batch_size: 1 },
    "tester",
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.end();
});
async function seed() {
  const source = (
    await pool.query(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES('kam','test','Test',$1,'branch','{}') RETURNING id",
      [settings.sources.kam.url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", "kam", source, null);
  await stagePage(run, {
    rows: [0, 1, 2, 3].map((i) => ({
      key: String(i),
      name: `Milk ${i} 1L`,
      description: null,
      category: null,
      gtin: null,
      price: "50",
      regular_price: null,
      promo_price: null,
      unit_price: null,
      available: i !== 3,
      promotion: null,
      source_updated_at: null,
      raw: {},
    })),
    next: null,
    total: 4,
    artifact: null,
  });
  await publishCatalog(await getRun(run.id));
  const ids = (
    await pool.query("SELECT id FROM store_products ORDER BY name")
  ).rows.map((r) => r.id as string);
  await pool.query(
    "INSERT INTO matching_prompt_versions(key,files) VALUES('test','[]') ON CONFLICT DO NOTHING",
  );
  for (const id of ids) {
    const p = await getProduct(id);
    await saveClassification(p, {
      key: (await classificationRequest(p)).key,
      family: "unknown",
      hints: [],
      selected: "dairy",
      probabilities: { dairy: 0.7, other_food: 0.3 },
      model: "mock-decider",
      prompt_key: "test",
      confidence: 0.99,
      generation_id: "mock",
    });
  }
  return ids;
}
async function start(limit = 1, maxCost = 0.1) {
  const saved = await readSettings();
  return createTask(
    {
      revision: saved.revision,
      kind: "llm_review",
      retailers: ["kam"],
      source_id: null,
      product_limit: limit,
      use_ai: true,
      categories: [],
      max_cost_usd: maxCost,
      recheck: false,
      idempotency_key: randomUUID(),
    },
    "tester",
  );
}
function provider(
  answer = {
    category: "dairy",
    reason: "Milk is a dairy product",
    quote: "Milk",
  },
) {
  const mock = vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    expect(body.model).toBe(settings.matching.gateway.extraction_model);
    expect(body.reasoning.enabled).toBe(false);
    expect(body.messages[0].content).toContain("untrusted");
    expect(body.messages[1].content).not.toContain("probabilities");
    return Response.json({
      id: "mock-qwen",
      choices: [{ message: { content: JSON.stringify(answer) } }],
      usage: { prompt_tokens: 500, completion_tokens: 50, cost: "0.00003" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
it("runs a bounded Qwen review, persists LLM provenance and original scores, and exposes results and the LLM review filter", async () => {
  const ids = await seed();
  const fetcher = provider();
  const task = await start();
  await executeTask(task.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = JSON.parse(fetcher.mock.calls[0][1].body as string);
  expect(body.response_format.json_schema.strict).toBe(true);
  const edited = (
    await pool.query("SELECT * FROM product_category_edits WHERE source='llm'")
  ).rows;
  expect(edited).toHaveLength(1);
  expect(edited[0].review_task_id).toBe(task.id);
  expect(edited[0].review_model).toBe(
    settings.matching.gateway.extraction_model,
  );
  expect(edited[0].review_generation_id).toBe("mock-qwen");
  const view = (await classificationViews([edited[0].store_product_id])).get(
    edited[0].store_product_id,
  )!;
  expect(view.state).toBe("llm");
  expect(view.source).toBe("llm");
  expect(view.options.find((o) => o.category === "dairy")?.probability).toBe(
    0.7,
  );
  const queue = await readQueue({
    status: "llm",
    availability: "available",
    search: "",
    page: 1,
    size: 10,
  });
  expect(queue.total).toBe(1);
  const results = await taskResults({
    id: task.id,
    page: 1,
    size: 10,
    search: "",
    category: "",
    outcome: "",
  });
  if (!results || results.kind === "match")
    throw new Error("Expected category results");
  expect(results?.rows[0].source).toBe("llm");
  expect(results?.rows[0].outcome).toBe("assigned");
  expect(results?.rows[0].model).toBe(
    settings.matching.gateway.extraction_model,
  );
  await executeTask(task.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const unchanged = await classificationViews(
    ids.filter((id) => id !== edited[0].store_product_id),
  );
  expect([...unchanged.values()].every((v) => v.state === "uncertain")).toBe(
    true,
  );
});
it("protects human and accepted decision-model choices, excludes unavailable products, and continues within the reviewed limit across batches", async () => {
  const ids = await seed();
  let p = await getProduct(ids[0]);
  let view = (await classificationViews([p.id])).get(p.id)!;
  await saveCategory(
    {
      id: p.group_id,
      member_id: p.id,
      snapshot: view.snapshot,
      action: "set",
      category: "other_food",
      note: "Human choice",
    },
    "tester",
  );
  p = await getProduct(ids[1]);
  await saveClassification(p, {
    key: (await classificationRequest(p)).key,
    family: "dairy",
    hints: [],
    selected: "dairy",
    probabilities: { dairy: 0.99 },
    model: "mock-decider",
    prompt_key: "test",
    confidence: 0.99,
    generation_id: "mock",
  });
  await pool.query(
    "UPDATE store_product_classifications SET family='dairy',probability=0.99,probabilities='{\"dairy\":0.99}'::jsonb WHERE store_product_id=$1",
    [ids[1]],
  );
  const fetcher = provider();
  const task = await start(50);
  await executeTask(task.id);
  await executeTask(task.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await classificationViews([ids[0]])).get(ids[0])?.source).toBe(
    "human",
  );
  expect(
    (
      await pool.query(
        "SELECT processed,state FROM task_executions WHERE id=$1",
        [task.id],
      )
    ).rows[0],
  ).toEqual({ processed: 1, state: "completed" });
  expect(await pendingProductContinuation(task.id)).toEqual([]);
});
it("keeps unknown answers in Review and does not select the same product twice in one task", async () => {
  await seed();
  const fetcher = provider({
    category: "unknown",
    reason: "Insufficient source information",
    quote: "",
  });
  const task = await start(2);
  await executeTask(task.id);
  await executeTask(task.id);
  await executeTask(task.id);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM product_category_edits WHERE source='llm'",
      )
    ).rows[0].n,
  ).toBe(0);
  const results = await taskResults({
    id: task.id,
    page: 1,
    size: 10,
    search: "",
    category: "",
    outcome: "",
  });
  expect(results?.rows.every((r) => r.outcome === "uncertain")).toBe(true);
  expect(results?.summary.needs_review).toBe(2);
});
it("defers unsupported quotes instead of saving them", async () => {
  await seed();
  provider({
    category: "dairy",
    reason: "Guessed detail",
    quote: "invented evidence",
  });
  const task = await start();
  await executeTask(task.id);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM product_category_edits WHERE source='llm'",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await pool.query("SELECT state FROM task_items WHERE task_id=$1", [
        task.id,
      ])
    ).rows[0].state,
  ).toBe("deferred");
});
it("blocks requests when AI is disabled or allowance is exhausted", async () => {
  await seed();
  const fetcher = provider();
  const task = await start(1, 0);
  await executeTask(task.id);
  expect(fetcher).not.toHaveBeenCalled();
  const saved = await readSettings();
  await saveSettings(
    saved.revision,
    { ...saved.policy, ai_enabled: false },
    "tester",
  );
  await expect(start()).rejects.toThrow("Enable AI");
});
it("never schedules LLM review automatically", async () => {
  const saved = await readSettings();
  await expect(
    createTask(
      {
        revision: saved.revision,
        kind: "llm_review",
        retailers: ["kam"],
        source_id: null,
        product_limit: 50,
        use_ai: true,
        categories: [],
        max_cost_usd: 0.1,
        recheck: false,
        idempotency_key: randomUUID(),
      },
      "scheduler",
      "automatic",
    ),
  ).rejects.toThrow("explicitly started");
});

it("does not overwrite a human correction made while Qwen is responding", async () => {
  await seed();
  const fetcher = provider();
  const response = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, options) => {
    const body = JSON.parse(options.body as string);
    const name = JSON.parse(body.messages[1].content).product.name;
    const p = (
      await pool.query("SELECT id,group_id FROM store_products WHERE name=$1", [
        name,
      ])
    ).rows[0];
    const view = (await classificationViews([p.id])).get(p.id)!;
    await saveCategory(
      {
        id: p.group_id,
        member_id: p.id,
        snapshot: view.snapshot,
        action: "set",
        category: "other_food",
        note: "Concurrent human choice",
      },
      "person",
    );
    return response(url, options);
  });
  const task = await start();
  await executeTask(task.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM product_category_edits WHERE source='llm'",
      )
    ).rows[0].n,
  ).toBe(0);
  const result = await taskResults({
    id: task.id,
    page: 1,
    size: 10,
    search: "",
    category: "",
    outcome: "",
  });
  expect(result?.rows[0].outcome).toBe("skipped");
});

it("recovers a committed LLM choice after a restart before its task checkpoint, without another provider call", async () => {
  await seed();
  const fetcher = provider();
  const task = await start();
  await executeTask(task.id);
  await pool.query(
    "UPDATE task_items SET state='pending',result=NULL,finished_at=NULL WHERE task_id=$1",
    [task.id],
  );
  await pool.query(
    "UPDATE task_executions SET state='queued',processed=0,unresolved=0 WHERE id=$1",
    [task.id],
  );
  await executeTask(task.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const result = await taskResults({
    id: task.id,
    page: 1,
    size: 10,
    search: "",
    category: "",
    outcome: "",
  });
  expect(result?.rows[0]).toMatchObject({
    source: "llm",
    outcome: "assigned",
    assigned_category: "dairy",
  });
});

it("honors pause-all before making any external request", async () => {
  await seed();
  const fetcher = provider();
  const task = await start();
  const saved = await readSettings();
  await saveSettings(
    saved.revision,
    { ...saved.policy, paused: true },
    "tester",
  );
  await executeTask(task.id);
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    (
      await pool.query("SELECT state FROM task_executions WHERE id=$1", [
        task.id,
      ])
    ).rows[0].state,
  ).toBe("paused");
});
