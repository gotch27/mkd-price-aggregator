import { randomUUID } from "node:crypto";
import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import {
  readSettings,
  saveSettings,
} from "@/nextsignal/services/task-settings";
import {
  createTask,
  executeTask,
  automaticTasks,
  pendingTasks,
  controlTask,
} from "@/nextsignal/services/tasks";
import { withTaskContext } from "@/nextsignal/services/task-context";
import {
  acquireGatewayPermit,
  gatewaySucceeded,
  releaseGatewayPermit,
} from "@/nextsignal/services/gateway-cooldown";
import { wakeCoolingTasks } from "@/nextsignal/services/task-cooldown";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import { families } from "@/nextsignal/domain/matching";
import type {
  OperationalPolicy,
  TaskExecution,
} from "@/nextsignal/domain/task-settings";
const original = structuredClone(settings.matching.gateway);
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated test database required");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.assign(settings.matching.gateway, original, {
    api_key: "isolated-test-key",
    consecutive_failure_limit: 2,
    retry_delay_ms: 1,
    retry_max_delay_ms: 1,
  });
  await pool.query(
    "TRUNCATE gateway_cooldown,logs,retailers,products,runs,sources,listings,ai_cache,operational_settings,operational_settings_history,task_executions CASCADE",
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
  await pool.query("TRUNCATE gateway_cooldown");
  Object.assign(settings.matching.gateway, original);
  vi.unstubAllGlobals();
  await pool.end();
});
async function policy(change: Partial<OperationalPolicy>, activate = false) {
  const s = await readSettings();
  return saveSettings(
    s.revision,
    { ...s.policy, ...change },
    "reviewer",
    activate,
  );
}
async function products(count: number) {
  const source = (
    await pool.query(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES('kam','one','one',$1,'branch','{}') RETURNING id",
      [settings.sources.kam.url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", "kam", source, null);
  await stagePage(run, {
    rows: Array.from({ length: count }, (_, i) => ({
      key: String(i),
      name: `Sample drink ${i} 330ml`,
      description: null,
      category: null,
      gtin: null,
      price: "40",
      regular_price: null,
      promo_price: null,
      unit_price: null,
      available: true,
      promotion: null,
      source_updated_at: null,
      raw: {},
    })),
    next: null,
    total: count,
    artifact: null,
  });
  await publishCatalog(await getRun(run.id));
  return (
    await pool.query(
      "SELECT id,group_id,version FROM store_products ORDER BY id",
    )
  ).rows;
}
async function start(limit: number | null = 4) {
  const s = await readSettings();
  return createTask(
    {
      revision: s.revision,
      kind: "categorize",
      retailers: ["kam"],
      source_id: null,
      product_limit: limit,
      use_ai: true,
      categories: [],
      max_cost_usd: 0.1,
      recheck: false,
      idempotency_key: randomUUID(),
    },
    "reviewer",
  );
}
async function task(id: string) {
  return (
    await pool.query<TaskExecution>(
      "SELECT * FROM task_executions WHERE id=$1",
      [id],
    )
  ).rows[0];
}
function succeed() {
  vi.mocked(fetch).mockImplementation(async () =>
    Response.json({
      answers: {
        family: {
          type: "choice",
          choice: "soft_drinks",
          probabilities: Object.fromEntries(
            families.map((f) => [f, f === "soft_drinks" ? 1 : 0]),
          ),
          confidence: 0.9,
        },
      },
      usage: { inputTokens: 100, outputTokens: 0 },
      providerMetadata: {
        gateway: { cost: "0.000002", generationId: randomUUID() },
      },
    }),
  );
}
function fail(status = 503) {
  vi.mocked(fetch).mockImplementation(async () => new Response("", { status }));
}
async function expire() {
  await pool.query(
    "UPDATE gateway_cooldown SET retry_at=now()-interval '1 second',probe_until=NULL",
  );
  await pool.query(
    "UPDATE task_executions SET retry_at=now()-interval '1 second' WHERE state='cooldown'",
  );
}
async function cooling() {
  await policy({ categorization: "automatic", ai_enabled: true });
  await products(4);
  fail();
  const t = await start();
  await executeTask(t.id);
  expect((await task(t.id)).state).toBe("cooldown");
  return t;
}

it("does not create empty automatic tasks for products in disabled stores", async () => {
  await products(3);
  await policy({ categorization: "automatic", ai_enabled: true }, true);
  const enabled = settings.sources.kam.enabled;
  try {
    settings.sources.kam.enabled = false;
    await automaticTasks();
    await automaticTasks();
    expect((await pool.query("SELECT * FROM task_executions")).rowCount).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    settings.sources.kam.enabled = true;
    await automaticTasks();
    expect((await pool.query("SELECT * FROM task_executions")).rowCount).toBe(1);
  } finally {
    settings.sources.kam.enabled = enabled;
  }
});

it("preserves old Automatic choices quietly until backlog activation is explicitly saved", async () => {
  await products(3);
  let s = await policy({ categorization: "automatic", ai_enabled: true });
  expect(s.category_backlog_active).toBe(false);
  await automaticTasks();
  expect((await pool.query("SELECT * FROM task_executions")).rowCount).toBe(0);
  s = await policy({ batch_size: 2 });
  expect(s.category_backlog_active).toBe(false);
  await automaticTasks();
  expect((await pool.query("SELECT * FROM task_executions")).rowCount).toBe(0);
  s = await policy({}, true);
  expect(s.category_backlog_active).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  await Promise.all([automaticTasks(), automaticTasks()]);
  expect(
    (await pool.query("SELECT * FROM task_executions WHERE origin='automatic'"))
      .rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT changes FROM operational_settings_history ORDER BY revision DESC LIMIT 1",
      )
    ).rows[0].changes,
  ).toContainEqual({
    field: "categorization_backlog",
    before: false,
    after: true,
  });
});

it("categorizes the existing available backlog in bounded tasks while reusing human, agent and saved model categories", async () => {
  const p = await products(6);
  await pool.query(
    "UPDATE store_product_sources SET available=false WHERE store_product_id=$1",
    [p[0].id],
  );
  await pool.query(
    "UPDATE store_products SET manual_family='soft_drinks',category_review_source='human' WHERE id=$1",
    [p[1].id],
  );
  await pool.query(
    "UPDATE store_products SET manual_family='soft_drinks',category_review_source='agent' WHERE id=$1",
    [p[2].id],
  );
  await pool.query(
    "UPDATE store_products SET category_pending=false,classified_family='soft_drinks' WHERE id=$1",
    [p[3].id],
  );
  await policy(
    {
      categorization: "automatic",
      ai_enabled: true,
      default_product_limit: 1,
      batch_size: 1,
    },
    true,
  );
  succeed();
  for (let i = 0; i < 3; i++) {
    await automaticTasks();
    for (const t of (
      await pool.query("SELECT id FROM task_executions WHERE state='queued'")
    ).rows)
      await executeTask(t.id);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(
    (await pool.query("SELECT * FROM task_executions WHERE origin='automatic'"))
      .rowCount,
  ).toBe(2);
  expect(
    (await pool.query("SELECT selected,processed,state FROM task_executions"))
      .rows,
  ).toEqual(
    expect.arrayContaining([{ selected: 1, processed: 1, state: "completed" }]),
  );
  expect(
    (
      await pool.query(
        "SELECT manual_family FROM store_products WHERE id=ANY($1::uuid[])",
        [[p[1].id, p[2].id]],
      )
    ).rows.every((r) => r.manual_family === "soft_drinks"),
  ).toBe(true);
});

it("does not take unfinished products from a paused manual task", async () => {
  const p = await products(2);
  let s = await policy(
    { categorization: "automatic", ai_enabled: true, default_product_limit: 2 },
    true,
  );
  const held = await start(1);
  await pool.query(
    "INSERT INTO task_items(task_id,input_id,store_product_id,group_id,input_version) VALUES($1,$2,$2,$3,$4)",
    [held.id, p[0].id, p[0].group_id, p[0].version],
  );
  await controlTask(held.id, "pause", s.revision, "reviewer");
  await automaticTasks();
  const auto = (
    await pool.query<TaskExecution>(
      "SELECT * FROM task_executions WHERE origin='automatic'",
    )
  ).rows[0];
  succeed();
  await executeTask(auto.id);
  await executeTask(auto.id);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await task(held.id)).state).toBe("paused");
  expect(
    (
      await pool.query(
        "SELECT classified_family FROM store_products WHERE id=$1",
        [p[0].id],
      )
    ).rows[0].classified_family,
  ).toBeNull();
});

it("uses durable increasing cooldowns, one recovery request and normal continuation after success", async () => {
  const t = await cooling();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await pendingTasks()).toEqual([]);
  await executeTask(t.id);
  expect(fetch).toHaveBeenCalledTimes(2);
  const first = (
    await pool.query(
      "SELECT extract(epoch from retry_at-now())::float seconds,cycles FROM gateway_cooldown",
    )
  ).rows[0];
  expect(first.cycles).toBe(1);
  expect(first.seconds).toBeGreaterThan(45);
  await expire();
  const wakes = await Promise.all([pendingTasks(), pendingTasks()]);
  expect(wakes.flat()).toHaveLength(1);
  await executeTask(t.id); // Exactly one failed half-open probe, not the whole batch.
  expect(fetch).toHaveBeenCalledTimes(3);
  expect((await task(t.id)).state).toBe("cooldown");
  const second = (
    await pool.query(
      "SELECT extract(epoch from retry_at-now())::float seconds,cycles FROM gateway_cooldown",
    )
  ).rows[0];
  expect(second.cycles).toBe(2);
  expect(second.seconds).toBeGreaterThan(100);
  await expire();
  await wakeCoolingTasks();
  succeed();
  await executeTask(t.id);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(await task(t.id)).toMatchObject({
    state: "completed",
    processed: 4,
    unresolved: 3,
  });
  expect(
    (
      await pool.query(
        "SELECT failures,cycles,retry_at,probe_token FROM gateway_cooldown",
      )
    ).rows[0],
  ).toMatchObject({
    failures: 0,
    cycles: 0,
    retry_at: null,
    probe_token: null,
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM ai_usage WHERE status='uncertain'",
      )
    ).rows[0].n,
  ).toBe(3);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM logs WHERE data->>'event'='gateway.cooldown.recovered'",
      )
    ).rows[0].n,
  ).toBe(1);
});

it("allows only one probe across concurrent workers and ignores stale probe completions", async () => {
  const t = await cooling();
  await expire();
  const live = await readSettings();
  const results = await withTaskContext(t, live, () =>
    Promise.allSettled([acquireGatewayPermit(), acquireGatewayPermit()]),
  );
  const success = results.find(
    (r) => r.status === "fulfilled",
  ) as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireGatewayPermit>>>;
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const first = success.value!;
  await releaseGatewayPermit(first);
  const second = await withTaskContext(t, live, () => acquireGatewayPermit());
  await gatewaySucceeded(first);
  expect(
    (await pool.query("SELECT probe_token FROM gateway_cooldown")).rows[0]
      .probe_token,
  ).toBe(second?.token);
  await gatewaySucceeded(second);
  expect(
    (await pool.query("SELECT retry_at FROM gateway_cooldown")).rows[0]
      .retry_at,
  ).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(["manual pause", "global pause", "AI off", "manual mode"] as const)(
  "respects %s while cooling down",
  async (mode) => {
    const t = await cooling();
    if (mode === "manual pause")
      await controlTask(
        t.id,
        "pause",
        (await readSettings()).revision,
        "reviewer",
      );
    if (mode === "global pause") await policy({ paused: true });
    if (mode === "AI off") await policy({ ai_enabled: false });
    if (mode === "manual mode") await policy({ categorization: "manual" });
    await expire();
    await wakeCoolingTasks();
    await automaticTasks();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await task(t.id)).state).toBe(
      mode === "global pause" ? "cooldown" : "paused",
    );
    if (mode === "global pause") {
      await policy({ paused: false });
      await wakeCoolingTasks();
      expect((await task(t.id)).state).toBe("queued");
    } else {
      await policy({ categorization: "automatic", ai_enabled: true });
      await wakeCoolingTasks();
      expect((await task(t.id)).state).toBe("paused");
    }
  },
);

it("keeps the original allowance and pauses on budget exhaustion without sending a recovery probe", async () => {
  const t = await cooling();
  await pool.query(
    "INSERT INTO ai_usage(task_id,endpoint,model,status,input_tokens,output_tokens,cost_usd) VALUES($1,'evaluate','mock','success',1,0,0.1)",
    [t.id],
  );
  await expire();
  await wakeCoolingTasks();
  await executeTask(t.id);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect((await task(t.id)).state).toBe("paused");
  expect((await task(t.id)).reason).toContain("spending");
  expect(
    (await pool.query("SELECT probe_token FROM gateway_cooldown")).rows[0]
      .probe_token,
  ).toBeNull();
});

it("cools down after bounded rate-limit retries and makes only one request on a failed recovery probe", async () => {
  await policy({ categorization: "automatic", ai_enabled: true });
  await products(2);
  fail(429);
  const t = await start(2);
  await executeTask(t.id);
  expect(fetch).toHaveBeenCalledTimes(settings.matching.gateway.retry_attempts);
  expect((await task(t.id)).state).toBe("cooldown");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM task_items WHERE state='deferred'",
      )
    ).rows[0].n,
  ).toBe(0);
  await expire();
  await wakeCoolingTasks();
  await executeTask(t.id);
  expect(fetch).toHaveBeenCalledTimes(
    settings.matching.gateway.retry_attempts + 1,
  );
  expect((await task(t.id)).state).toBe("cooldown");
});

it("caps the cooldown and recovers an abandoned probe lease without trusting its stale success", async () => {
  const { gatewayFailed } =
    await import("@/nextsignal/services/gateway-cooldown");
  const t = await cooling();
  await expire();
  const live = await readSettings();
  const stale = await withTaskContext(t, live, () => acquireGatewayPermit());
  await pool.query(
    "UPDATE gateway_cooldown SET cycles=50,probe_until=now()-interval '1 second'",
  );
  const current = await withTaskContext(t, live, () => acquireGatewayPermit());
  expect(current?.token).not.toBe(stale?.token);
  await gatewaySucceeded(stale);
  expect(
    (await pool.query("SELECT probe_token FROM gateway_cooldown")).rows[0]
      .probe_token,
  ).toBe(current?.token);
  const until = await gatewayFailed(current, false);
  expect(until).not.toBeNull();
  const seconds = (
    await pool.query(
      "SELECT extract(epoch from retry_at-now())::float seconds FROM gateway_cooldown",
    )
  ).rows[0].seconds;
  expect(seconds).toBeGreaterThan(
    settings.matching.gateway.cooldown_max_seconds - 5,
  );
  expect(seconds).toBeLessThanOrEqual(
    settings.matching.gateway.cooldown_max_seconds,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("shares failure streaks across automatic batches and does not create replacement work during cooldown", async () => {
  await products(4);
  await policy(
    { categorization: "automatic", ai_enabled: true, default_product_limit: 1 },
    true,
  );
  fail();
  await automaticTasks();
  const first = (
    await pool.query<TaskExecution>(
      "SELECT * FROM task_executions WHERE origin='automatic'",
    )
  ).rows[0];
  await executeTask(first.id);
  expect((await task(first.id)).state).toBe("completed");
  await automaticTasks();
  const second = (
    await pool.query<TaskExecution>(
      "SELECT * FROM task_executions WHERE origin='automatic' AND state='queued'",
    )
  ).rows[0];
  await executeTask(second.id);
  expect((await task(second.id)).state).toBe("cooldown");
  await automaticTasks();
  expect(
    (await pool.query("SELECT count(*)::int n FROM task_executions")).rows[0].n,
  ).toBe(2);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not bypass a paused automatic task request limit by creating a fresh backlog task", async () => {
  await products(4);
  await policy(
    {
      categorization: "automatic",
      ai_enabled: true,
      default_product_limit: 2,
      task_request_limit: 1,
    },
    true,
  );
  fail(429);
  await automaticTasks();
  const first = (
    await pool.query<TaskExecution>(
      "SELECT * FROM task_executions WHERE origin='automatic'",
    )
  ).rows[0];
  await executeTask(first.id);
  expect((await task(first.id)).state).toBe("paused");
  expect((await task(first.id)).reason).toContain("request limit");
  await automaticTasks();
  expect(
    (await pool.query("SELECT count(*)::int n FROM task_executions")).rows[0].n,
  ).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("hands off the next bounded automatic backlog batch without waiting for the minute scheduler", async () => {
  const { pendingAutomaticCategoryContinuation } =
    await import("@/nextsignal/services/tasks");
  await products(3);
  await policy(
    { categorization: "automatic", ai_enabled: true, default_product_limit: 1 },
    true,
  );
  succeed();
  await automaticTasks();
  const first = (
    await pool.query<TaskExecution>(
      "SELECT * FROM task_executions WHERE origin='automatic'",
    )
  ).rows[0];
  expect(await pendingAutomaticCategoryContinuation(first.id)).toEqual([]);
  await executeTask(first.id);
  const next = await pendingAutomaticCategoryContinuation(first.id);
  expect(next).toHaveLength(1);
  await executeTask(next[0].id);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect((await task(next[0].id)).options.product_limit).toBe(1);
  await policy({ paused: true });
  expect(await pendingAutomaticCategoryContinuation(next[0].id)).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
