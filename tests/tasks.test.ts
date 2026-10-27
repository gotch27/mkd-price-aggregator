import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { app } from "@/nextsignal/app";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import {
  readSettings,
  saveSettings,
  settingsHistory,
  nextOccurrences,
} from "@/nextsignal/services/task-settings";
import {
  createTask,
  executeTask,
  controlTask,
  authorizeRun,
  scheduleTasks,
  automaticTasks,
} from "@/nextsignal/services/tasks";
import {
  checkpoint,
  withTaskContext,
} from "@/nextsignal/services/task-context";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
  saveDiscovery,
} from "@/nextsignal/services/catalog-repository";
import {
  createRun,
  getRun,
  pendingRuns,
  claimPendingRuns,
  releaseDispatch,
} from "@/nextsignal/services/run-repository";
import { families } from "@/nextsignal/domain/matching";
import { taskResults } from "@/nextsignal/services/task-results";
import { readFile } from "node:fs/promises";
import type {
  TaskCommand,
  OperationalPolicy,
  TaskExecution,
} from "@/nextsignal/domain/task-settings";
import type { Retailer, CatalogRow } from "@/nextsignal/domain/types";
const original = structuredClone(settings.matching.gateway);
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await pool.query("TRUNCATE gateway_cooldown");
  Object.assign(settings.matching.gateway, original, {
    api_key: "isolated-test-key",
  });
  await pool.query(
    `TRUNCATE retailers,products,runs,sources,listings,ai_cache,host_limits,operational_settings,operational_settings_history,task_executions CASCADE`,
  );
  await seedRetailers();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected external activity");
    }),
  );
});
afterAll(async () => {
  await pool.query("TRUNCATE gateway_cooldown");
  Object.assign(settings.matching.gateway, original);
  vi.unstubAllGlobals();
  await pool.end();
});
const pageRow = (n: number): CatalogRow => ({
  key: `progress-${n}`,
  name: `Milk product ${n} 1L`,
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
});
async function policy(changes: Partial<OperationalPolicy>) {
  const current = await readSettings();
  return saveSettings(
    current.revision,
    { ...current.policy, ...changes },
    "tester",
  );
}
async function start(changes: Partial<TaskCommand> = {}) {
  const saved = await readSettings();
  return createTask(
    {
      revision: saved.revision,
      kind: "match",
      retailers: ["kam"],
      source_id: null,
      product_limit: 50,
      use_ai: false,
      categories: [],
      max_cost_usd: 0,
      recheck: false,
      idempotency_key: randomUUID(),
      ...changes,
    },
    "tester",
  );
}
async function task(id: string) {
  return (
    await pool.query<TaskExecution & { dispatch_until: Date | null }>(
      `SELECT * FROM task_executions WHERE id=$1`,
      [id],
    )
  ).rows[0];
}
async function publish(
  retailer: Retailer,
  names: string[],
  owner?: TaskExecution,
  branch = "one",
) {
  const source = (
    await pool.query(
      `INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,$2,$3,'branch','{}') ON CONFLICT(retailer,external_id) DO UPDATE SET active=true RETURNING id`,
      [retailer, branch, settings.sources[retailer].url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", retailer, source, null);
  const rows: CatalogRow[] = names.map((name, i) => ({
    key: String(i),
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
  }));
  await stagePage(run, {
    rows,
    next: null,
    total: rows.length,
    artifact: null,
  });
  const work = async () => publishCatalog(await getRun(run.id));
  if (owner) await withTaskContext(owner, await readSettings(), work);
  else await work();
  return source;
}
function provider() {
  const calls = { category: 0, match: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      const category = !!body.questions.family;
      if (category) calls.category++;
      else calls.match++;
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((key) => [
          key,
          {
            type: "choice",
            choice: category ? "soft_drinks" : "same",
            probabilities: category
              ? Object.fromEntries(
                  families.map((f) => [f, f === "soft_drinks" ? 1 : 0]),
                )
              : { same: 0.99, different: 0.005, insufficient: 0.005 },
            confidence: 0.9,
          },
        ]),
      );
      return Response.json({
        answers,
        usage: { inputTokens: 100, outputTokens: 0 },
        providerMetadata: {
          gateway: { cost: "0.000002", generationId: randomUUID() },
        },
      });
    }),
  );
  return calls;
}
it("starts quietly, persists choices, audits changes and rejects stale concurrent saves", async () => {
  const initial = await readSettings();
  expect(initial.policy).toMatchObject({
    imports: "manual",
    categorization: "manual",
    matching: "manual",
    ai_enabled: false,
    scheduled_stores: [],
    default_product_limit: 50,
  });
  const next = await policy({ matching: "automatic" });
  expect((await readSettings()).revision).toBe(next.revision);
  await expect(
    saveSettings(initial.revision, initial.policy, "stale"),
  ).rejects.toThrow("another session");
  expect((await settingsHistory(1, 10)).rows[0]).toMatchObject({
    actor: "tester",
    changes: [{ field: "matching", before: "manual", after: "automatic" }],
  });
  await scheduleTasks(new Date());
  await automaticTasks();
  expect((await pool.query(`SELECT * FROM task_executions`)).rowCount).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it("holds migrated queue work, including already delivered jobs", async () => {
  const legacy = await createRun("discover", "kam", null, null);
  expect(await pendingRuns(50)).toHaveLength(0);
  const execute = vi.fn();
  expect(await authorizeRun(legacy.id, execute)).toBeNull();
  expect(execute).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("manual code matching works with automation and AI off and never categorizes", async () => {
  await publish("kam", ["Coca Cola 330 ml", "Pepsi 500 ml"]);
  await publish("spar", ["Coca Cola 330 ml"]);
  const run = await start({ product_limit: 1 });
  await executeTask(run.id);
  expect(await task(run.id)).toMatchObject({
    state: "completed",
    selected: 1,
    processed: 1,
  });
  expect(fetch).not.toHaveBeenCalled();
  expect((await pool.query(`SELECT * FROM ai_usage`)).rowCount).toBe(0);
  await executeTask(run.id);
  expect((await task(run.id)).processed).toBe(1);
});
it("rejects removed preparation commands without authorizing work", async () => {
  const owner = await start();
  await expect(
    createTask(
      {
        ...owner.options,
        kind: "prepare",
        idempotency_key: randomUUID(),
      } as unknown as TaskCommand,
      "tester",
    ),
  ).rejects.toThrow();
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM task_executions")).rows[0]
      .n,
  ).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});
it("matching does not convert older database records behind the scenes", async () => {
  await publish("kam", ["one", "two", "three"]);
  await pool.query(`TRUNCATE store_products CASCADE`);
  await pool.query(`REFRESH MATERIALIZED VIEW catalog_browser`);
  const run = await start({ product_limit: 1 });
  await executeTask(run.id);
  expect(await task(run.id)).toMatchObject({
    state: "completed",
    selected: 0,
    processed: 0,
  });
  expect((await pool.query(`SELECT * FROM store_products`)).rowCount).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it("a queued removed maintenance task fails safely instead of resuming", async () => {
  const owner = await start();
  await pool.query(
    `UPDATE task_executions SET kind='prepare',options=jsonb_set(options,'{kind}','"prepare"'::jsonb) WHERE id=$1`,
    [owner.id],
  );
  await executeTask(owner.id);
  expect(await task(owner.id)).toMatchObject({
    state: "failed",
    reason:
      "This saved task is no longer supported. Start a new task from Tasks.",
  });
  expect(fetch).not.toHaveBeenCalled();
  expect((await pool.query("SELECT * FROM store_products")).rowCount).toBe(0);
});
it("separates categorization from matching and enforces 50 across batches/restarts", async () => {
  await policy({ ai_enabled: true, batch_size: 7 });
  await publish(
    "kam",
    Array.from({ length: 55 }, (_, i) => `Unique drink ${i} 330 ml`),
  );
  const calls = provider(),
    run = await start({ kind: "categorize", use_ai: true, max_cost_usd: 0.1 });
  for (let i = 0; i < 10; i++) await executeTask(run.id);
  expect(await task(run.id)).toMatchObject({
    state: "completed",
    processed: 50,
    selected: 50,
  });
  expect(calls).toEqual({ category: 50, match: 0 });
  expect(
    (
      await pool.query(
        `SELECT count(*)::int AS n FROM store_products WHERE classified_family IS NULL`,
      )
    ).rows[0].n,
  ).toBe(5);
});
it("categorizes products with conflicting source identities without connecting them or reporting a missing category as saved", async () => {
  await policy({ ai_enabled: true });
  await publish("kam", ["Example milk 1L"]);
  await pool.query(
    "UPDATE store_products SET ambiguous=true,branch_conflict=true",
  );
  const calls = provider();
  const run = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  expect(calls).toEqual({ category: 1, match: 0 });
  expect(
    (
      await pool.query(
        "SELECT classified_family,ambiguous,branch_conflict FROM store_products",
      )
    ).rows[0],
  ).toMatchObject({
    classified_family: "soft_drinks",
    ambiguous: true,
    branch_conflict: true,
  });
  expect(await task(run.id)).toMatchObject({ processed: 1, unresolved: 0 });
  expect(
    (await pool.query("SELECT * FROM store_match_decisions")).rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT data FROM logs WHERE data->>'event'='tasks.batch.completed' AND data->>'task_id'=$1",
        [run.id],
      )
    ).rows.at(-1)?.data,
  ).toMatchObject({ category_results_saved: 1, without_result: 0 });
});
it("reports a stale classification as unresolved and keeps it waiting for a deliberate later task", async () => {
  await policy({ ai_enabled: true });
  await publish("kam", ["Example milk 1L"]);
  await pool.query(
    "UPDATE store_products SET classification_key='older-input',classified_family='soft_drinks'",
  );
  provider();
  const respond = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    const result = await respond(...args);
    await pool.query(
      `UPDATE store_products SET manual_facts='{"brand":"Corrected during request"}',version=version+1`,
    );
    return result;
  });
  const run = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  expect(await task(run.id)).toMatchObject({ processed: 1, unresolved: 1 });
  expect(
    (await pool.query("SELECT category_pending FROM store_products")).rows[0]
      .category_pending,
  ).toBe(true);
  expect(
    (
      await pool.query("SELECT state,reason FROM task_items WHERE task_id=$1", [
        run.id,
      ])
    ).rows,
  ).toEqual([
    {
      state: "unresolved",
      reason: "No category saved; product needs attention",
    },
  ]);
});
it("shows immutable, paginated categorization results with uncertainty, search, category filters and no additional calls", async () => {
  await policy({ ai_enabled: true });
  await publish("kam", [
    "Drink alpha 330ml",
    "Drink beta 330ml",
    "Unclear product",
    "Drink delta 330ml",
    "Drink epsilon 330ml",
  ]);
  provider();
  const respond = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    const body = JSON.parse(String(args[1]?.body));
    if (body.state.product.name !== "Unclear product") return respond(...args);
    return Response.json({
      answers: {
        family: {
          type: "choice",
          choice: "other_food",
          probabilities: Object.fromEntries(
            families.map((f) => [
              f,
              f === "other_food" ? 0.6 : 0.4 / (families.length - 1),
            ]),
          ),
          confidence: 0.9,
        },
      },
      usage: { inputTokens: 100, outputTokens: 0 },
      providerMetadata: {
        gateway: { cost: "0.000002", generationId: randomUUID() },
      },
    });
  });
  const run = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  const calls = vi.mocked(fetch).mock.calls.length;
  const query = {
    id: run.id,
    page: 1,
    size: 2,
    search: "",
    category: "",
    outcome: "",
  };
  const results = await taskResults(query);
  expect(results?.summary).toEqual({
    total: 5,
    assigned: 4,
    needs_review: 1,
    reviewed: 0,
    skipped: 0,
    waiting: 0,
    deferred: 0,
  });
  expect(results?.total_pages).toBe(3);
  const next = await taskResults({ ...query, page: 2 });
  expect(new Set([...results!.rows, ...next!.rows].map((r) => r.id)).size).toBe(
    4,
  );
  const review = await taskResults({ ...query, outcome: "needs_review" });
  expect(review?.rows[0]).toMatchObject({
    name: "Unclear product",
    assigned_category: "unknown",
    suggested_category: "other_food",
    probability: 0.6,
    threshold: 0.8,
    outcome: "uncertain",
  });
  expect(
    (await taskResults({ ...query, category: "soft_drinks" }))?.total,
  ).toBe(4);
  expect((await taskResults({ ...query, search: "beta" }))?.rows[0].name).toBe(
    "Drink beta 330ml",
  );
  expect(
    (await taskResults({ ...query, search: "no such product" }))?.total,
  ).toBe(0);
  expect((await taskResults({ ...query, page: 100 }))?.page).toBe(3);
  await pool.query(
    "UPDATE store_products SET name='Renamed later',category='Changed category',classified_family='alcohol'",
  );
  expect(
    (await taskResults({ ...query, search: "beta" }))?.rows[0],
  ).toMatchObject({
    name: "Drink beta 330ml",
    source_category: null,
    assigned_category: "soft_drinks",
  });
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  expect(
    (
      await pool.query(
        "SELECT * FROM task_items WHERE task_id=$1 AND result IS NOT NULL AND finished_at IS NOT NULL",
        [run.id],
      )
    ).rowCount,
  ).toBe(5);
  // Cached/saved categories still produce a task result without another charge.
  const repeat = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
    recheck: true,
    product_limit: 1,
  });
  // Restore the immutable source names so this test deliberately exercises reuse.
  await pool.query(
    `UPDATE store_products sp SET name=ti.result->>'name',category=NULL,classified_family=ti.result->>'assigned_category' FROM task_items ti WHERE ti.task_id=$1 AND ti.store_product_id=sp.id`,
    [run.id],
  );
  await executeTask(repeat.id);
  expect((await taskResults({ ...query, id: repeat.id }))?.summary.total).toBe(
    1,
  );
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
});
it("recovers the existing paid categorization results by exact task and generation without reclassifying", async () => {
  await policy({ ai_enabled: true });
  await publish("kam", ["Drink alpha 330ml", "Drink beta 330ml"]);
  provider();
  const run = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  const before = (await taskResults({
    id: run.id,
    page: 1,
    size: 10,
    search: "",
    category: "",
    outcome: "",
  }))!;
  const calls = vi.mocked(fetch).mock.calls.length;
  await pool.query(
    "UPDATE task_items SET result=NULL,finished_at=NULL WHERE task_id=$1",
    [run.id],
  );
  const migration = await readFile(
    "migrations/031_task_category_results.sql",
    "utf8",
  );
  await pool.query(migration.slice(migration.indexOf("WITH recorded AS")));
  const restored = (await taskResults({
    id: run.id,
    page: 1,
    size: 10,
    search: "",
    category: "",
    outcome: "",
  }))!;
  expect(
    restored.rows.map((r) => [
      r.name,
      r.assigned_category,
      r.classification_id,
    ]),
  ).toEqual(
    before.rows.map((r) => [r.name, r.assigned_category, r.classification_id]),
  );
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
});
it("protects result reads with authentication and validates route filters", async () => {
  await policy({ ai_enabled: true });
  await publish("kam", ["Drink alpha 330ml"]);
  provider();
  const run = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  const { GET } = await import("@/app/api/tasks/[id]/results/route");
  const { SESSION_COOKIE, sessionToken } =
    await import("@/nextsignal/adapters/auth");
  const context = { params: Promise.resolve({ id: run.id }) };
  const url = new URL(
    `/api/tasks/${run.id}/results?page=1&size=10&search=&category=&outcome=`,
    settings.auth.allowed_origins[0],
  );
  expect((await GET(new Request(url), context)).status).toBe(401);
  const headers = { cookie: `${SESSION_COOKIE}=${sessionToken()}` };
  const response = await GET(new Request(url, { headers }), context);
  expect(response.status).toBe(200);
  expect((await response.json()).data.rows).toHaveLength(1);
  url.searchParams.set("outcome", "invalid");
  expect((await GET(new Request(url, { headers }), context)).status).toBe(400);
  url.searchParams.set("outcome", "");
  url.searchParams.set("page", "0");
  expect((await GET(new Request(url, { headers }), context)).status).toBe(400);
  url.searchParams.set("page", "1");
  expect(
    (
      await GET(new Request(url, { headers }), {
        params: Promise.resolve({ id: randomUUID() }),
      })
    ).status,
  ).toBe(404);
});
it("AI matching never secretly categorizes an uncategorized product", async () => {
  await publish("kam", ["Coca Cola 330 ml"]);
  await policy({ ai_enabled: true });
  const calls = provider();
  const run = await start({
    use_ai: true,
    categories: ["soft_drinks"],
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  expect(await task(run.id)).toMatchObject({
    state: "completed",
    processed: 0,
  });
  expect(calls).toEqual({ category: 0, match: 0 });
});
it("permission increases do not sweep backlog; new publications alone receive automation grants", async () => {
  await publish("kam", ["Old item"]);
  await policy({
    matching: "automatic",
    categorization: "automatic",
    ai_enabled: true,
    ai_categories: ["soft_drinks"],
  });
  await automaticTasks();
  expect((await pool.query(`SELECT * FROM task_executions`)).rowCount).toBe(0);
  const owner = await start({ kind: "import" });
  await publish("spar", ["New item"], owner);
  await automaticTasks();
  const tasks = (
    await pool.query(
      `SELECT kind,options FROM task_executions WHERE origin='automatic'`,
    )
  ).rows;
  expect(tasks.map((t) => t.kind).sort()).toEqual(["categorize", "match"]);
  expect(
    (
      await pool.query(
        `SELECT auto_match_epoch FROM matching_work w JOIN store_products sp ON sp.id=w.store_product_id WHERE sp.retailer='kam'`,
      )
    ).rows[0].auto_match_epoch,
  ).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it("import tasks capture permission so toggling automation mid-task cannot expand it", async () => {
  const owner = await start({ kind: "import" });
  await policy({ matching: "automatic", ai_enabled: true });
  await publish("kam", ["New product"], owner);
  await automaticTasks();
  expect(
    (await pool.query(`SELECT * FROM task_executions WHERE origin='automatic'`))
      .rowCount,
  ).toBe(0);
});
it("stops at a safe checkpoint when AI permission is removed, preserving per-task spending", async () => {
  await policy({ ai_enabled: true });
  await publish("kam", ["Drink A 330 ml", "Drink B 330 ml"]);
  const calls = provider();
  const originalFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      await policy({ ai_enabled: false });
      return response;
    }),
  );
  const run = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  expect(calls.category).toBe(1);
  expect((await task(run.id)).state).toBe("paused");
  const spent = (
    await pool.query(
      `SELECT sum(cost_usd) AS cost FROM ai_usage WHERE task_id=$1`,
      [run.id],
    )
  ).rows[0].cost;
  await policy({ ai_enabled: true });
  await executeTask(run.id);
  expect(calls.category).toBe(1);
  await controlTask(
    run.id,
    "resume",
    (await readSettings()).revision,
    "tester",
  );
  await executeTask(run.id);
  expect(
    Number(
      (
        await pool.query(
          `SELECT sum(cost_usd) AS cost FROM ai_usage WHERE task_id=$1`,
          [run.id],
        )
      ).rows[0].cost,
    ),
  ).toBeGreaterThanOrEqual(Number(spent));
});
it("per-task request limits remain enforced after a resume", async () => {
  await policy({ ai_enabled: true, task_request_limit: 1 });
  await publish("kam", ["First 330 ml", "Second 330 ml"]);
  const calls = provider();
  const run = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  expect(calls.category).toBe(1);
  expect((await task(run.id)).state).toBe("paused");
  await controlTask(
    run.id,
    "resume",
    (await readSettings()).revision,
    "tester",
  );
  await executeTask(run.id);
  expect(calls.category).toBe(1);
  expect((await task(run.id)).state).toBe("paused");
});
it("pause all and operation off block requests; manual-only still permits explicit tasks", async () => {
  const run = await start({ kind: "import" });
  await policy({ paused: true });
  await executeTask(run.id);
  expect((await task(run.id)).state).toBe("paused");
  await policy({ paused: false, imports: "off" });
  await expect(
    controlTask(run.id, "resume", (await readSettings()).revision, "tester"),
  ).rejects.toThrow("off");
  await policy({ imports: "manual" });
  await controlTask(
    run.id,
    "resume",
    (await readSettings()).revision,
    "tester",
  );
  await executeTask(run.id);
  expect((await task(run.id)).state).toBe("running");
  expect(fetch).not.toHaveBeenCalled();
});
it("discovery-only tasks do not create price-import children", async () => {
  const owner = await start({ kind: "discover" });
  await executeTask(owner.id);
  const run = (
    await pool.query(`SELECT id FROM runs WHERE task_id=$1`, [owner.id])
  ).rows[0];
  await withTaskContext(await task(owner.id), await readSettings(), async () =>
    saveDiscovery(await getRun(run.id), [
      {
        retailer: "kam",
        external_id: "branch",
        name: "Branch",
        url: settings.sources.kam.url,
        scope: "branch",
        meta: {},
      },
    ]),
  );
  expect(
    (
      await pool.query(
        `SELECT * FROM runs WHERE task_id=$1 AND kind='catalog'`,
        [owner.id],
      )
    ).rowCount,
  ).toBe(0);
});
it("schedules only future imports, handles catch-up once and deduplicates scheduler workers", async () => {
  const saved = await policy({
    imports: "automatic",
    scheduled_stores: ["kam"],
    catch_up: false,
  });
  await scheduleTasks(new Date());
  expect((await pool.query(`SELECT * FROM task_executions`)).rowCount).toBe(0);
  await pool.query(
    `UPDATE operational_settings SET next_due=now()-interval '1 day'`,
  );
  await scheduleTasks(new Date());
  expect((await pool.query(`SELECT * FROM task_executions`)).rowCount).toBe(0);
  await policy({ catch_up: true });
  await pool.query(
    `UPDATE operational_settings SET next_due=now()-interval '10 day'`,
  );
  await Promise.all([scheduleTasks(new Date()), scheduleTasks(new Date())]);
  expect(
    (await pool.query(`SELECT * FROM task_executions WHERE origin='scheduled'`))
      .rowCount,
  ).toBe(1);
  expect((await readSettings()).epochs.imports).toBe(saved.epochs.imports);
  expect(fetch).not.toHaveBeenCalled();
});
it("uses Skopje daylight-saving time and rejects invalid cron", async () => {
  expect(
    nextOccurrences("0 12 * * *", new Date("2026-10-24T11:00:00Z"), 2),
  ).toEqual(["2026-10-25T11:00:00.000Z", "2026-10-26T11:00:00.000Z"]);
  await expect(policy({ cron: "invalid" })).rejects.toThrow();
});
it("requires authentication, validates reviewed revisions and never mutates on invalid input", async () => {
  const result = await app.dispatch("tasks.start", {});
  expect(result.ok).toBe(false);
  const saved = await readSettings();
  await policy({ batch_size: 4 });
  await expect(start({ revision: saved.revision })).rejects.toThrow(
    "Settings changed",
  );
  expect((await pool.query(`SELECT * FROM task_executions`)).rowCount).toBe(0);
});
it("rejects paid work before any request when the shared initial allowance is spent", async () => {
  await policy({ ai_enabled: true });
  await publish("kam", ["Another drink 330 ml"]);
  const calls = provider();
  const campaign = (
    await pool.query(
      `INSERT INTO matching_campaigns(kind,state,reason) VALUES('initial','running','existing initial spend') RETURNING id`,
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO ai_usage(campaign_id,endpoint,model,status,input_tokens,output_tokens,cost_usd) VALUES($1,'evaluate','test','success',1,0,25)`,
    [campaign.id],
  );
  const run = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  expect(await task(run.id)).toMatchObject({ state: "paused", processed: 0 });
  expect(calls.category).toBe(0);
});
it("zero per-task allowance stops paid work without erasing progress or reservations", async () => {
  await policy({ ai_enabled: true });
  await publish("kam", ["Zero budget drink 330 ml"]);
  const calls = provider();
  const run = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0,
  });
  await executeTask(run.id);
  expect((await task(run.id)).state).toBe("paused");
  expect(calls.category).toBe(0);
  expect(
    (await pool.query(`SELECT * FROM ai_usage WHERE task_id=$1`, [run.id]))
      .rowCount,
  ).toBe(0);
});
it("retains manual limits when settings are increased and does not process another store", async () => {
  await publish("kam", ["One 330 ml", "Two 330 ml", "Three 330 ml"]);
  await publish("spar", ["Another 330 ml"]);
  const saved = await policy({ ai_enabled: true, batch_size: 1 });
  const calls = provider();
  const run = await start({
    kind: "categorize",
    use_ai: true,
    product_limit: 2,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  await policy({
    default_product_limit: 1000,
    task_budget_usd: 1,
    ai_categories: ["dairy"],
  });
  await executeTask(run.id);
  await executeTask(run.id);
  expect(await task(run.id)).toMatchObject({
    state: "completed",
    processed: 2,
    settings_revision: saved.revision,
  });
  expect(calls.category).toBe(2);
  expect(
    (
      await pool.query(
        `SELECT classified_family FROM store_products WHERE retailer='spar'`,
      )
    ).rows[0].classified_family,
  ).toBeNull();
});
it("changing automation to manual stops only automatic work", async () => {
  await policy({ matching: "automatic" });
  const owner = await start({ kind: "import" });
  await publish("kam", ["First new 330 ml"], owner);
  await automaticTasks();
  const automatic = (
    await pool.query<TaskExecution>(
      `SELECT * FROM task_executions WHERE origin='automatic'`,
    )
  ).rows[0];
  const manual = await start();
  await policy({ matching: "manual" });
  await executeTask(automatic.id);
  expect((await task(automatic.id)).state).toBe("paused");
  await executeTask(manual.id);
  expect((await task(manual.id)).state).not.toBe("paused");
  expect(fetch).not.toHaveBeenCalled();
});
it("discovering as part of an import propagates authorization to its catalog children", async () => {
  const owner = await start({ kind: "import" });
  await executeTask(owner.id);
  const run = (
    await pool.query(`SELECT id FROM runs WHERE task_id=$1`, [owner.id])
  ).rows[0];
  await withTaskContext(await task(owner.id), await readSettings(), async () =>
    saveDiscovery(await getRun(run.id), [
      {
        retailer: "kam",
        external_id: "branch",
        name: "Branch",
        url: settings.sources.kam.url,
        scope: "branch",
        meta: {},
      },
    ]),
  );
  expect(
    (await pool.query(`SELECT task_id FROM runs WHERE kind='catalog'`)).rows,
  ).toEqual([{ task_id: owner.id }]);
});
it("lower live task allowances stop the next request, including resumed work", async () => {
  await policy({ ai_enabled: true, batch_size: 1 });
  await publish("kam", ["First budget 330 ml", "Second budget 330 ml"]);
  const calls = provider();
  const run = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
    product_limit: 2,
  });
  await executeTask(run.id);
  expect(calls.category).toBe(1);
  await policy({ task_budget_usd: 0 });
  await executeTask(run.id);
  expect(calls.category).toBe(1);
  expect((await task(run.id)).state).toBe("paused");
});
it("settings outages fail closed before a provider request", async () => {
  const owner = await start({ kind: "import" });
  const live = await readSettings();
  await pool.query(
    `ALTER TABLE operational_settings RENAME TO unavailable_operational_settings`,
  );
  try {
    await withTaskContext(owner, live, async () => {
      await expect(checkpoint()).rejects.toThrow("settings cannot be read");
    });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await pool.query(
      `ALTER TABLE unavailable_operational_settings RENAME TO operational_settings`,
    );
  }
});
it("restores authorized checkpoints on worker restart but leaves legacy queues held", async () => {
  const { recoverAuthorizedWork } = await import("@/nextsignal/services/tasks");
  const owner = await start({ kind: "import" });
  await executeTask(owner.id);
  const run = (
    await pool.query(`SELECT id FROM runs WHERE task_id=$1`, [owner.id])
  ).rows[0];
  const legacy = await createRun("discover", "spar", null, null);
  await pool.query(
    `UPDATE runs SET status='running' WHERE id=ANY($1::uuid[])`,
    [[run.id, legacy.id]],
  );
  await recoverAuthorizedWork();
  expect((await getRun(run.id)).status).toBe("pending");
  expect((await getRun(legacy.id)).status).toBe("running");
  expect(fetch).not.toHaveBeenCalled();
});
it("manual AI run category selection does not change the saved automatic selection", async () => {
  await policy({ ai_enabled: true, ai_categories: ["dairy"] });
  await publish("kam", ["Coca Cola 330 ml"]);
  await publish("spar", ["Coca Cola 330 ml"]);
  const calls = provider();
  const categorize = await start({
    kind: "categorize",
    retailers: ["kam", "spar"],
    use_ai: true,
    max_cost_usd: 0.1,
    product_limit: 2,
  });
  await executeTask(categorize.id);
  const match = await start({
    use_ai: true,
    categories: ["soft_drinks"],
    max_cost_usd: 0.1,
    product_limit: 1,
  });
  await executeTask(match.id);
  expect(calls.category).toBe(2);
  expect((await readSettings()).policy.ai_categories).toEqual(["dairy"]);
  expect((await task(match.id)).processed).toBe(1);
});
it("keeps a catalog pause distinct from a failed retrieval", async () => {
  const { services } = await import("@/nextsignal/services");
  const source = await publish("kam", ["Before 330 ml"]);
  const owner = await start({ kind: "import", source_id: source });
  await executeTask(owner.id);
  const run = (
    await pool.query(`SELECT id FROM runs WHERE task_id=$1`, [owner.id])
  ).rows[0];
  vi.spyOn(services.importers, "retrieve").mockImplementation(
    async function* () {
      await policy({ paused: true });
      yield { rows: [], next: null, total: 0, artifact: null };
    },
  );
  await authorizeRun(run.id, () =>
    app.dispatch("catalog.execute", { run_id: run.id }),
  );
  expect((await getRun(run.id)).status).toBe("paused");
  expect((await task(owner.id)).state).toBe("paused");
});
it("serves authenticated settings routes, audits saves and rejects foreign origins", async () => {
  const { GET, PATCH } = await import("@/app/api/task-settings/route");
  const { SESSION_COOKIE, sessionToken } =
    await import("@/nextsignal/adapters/auth");
  const origin = settings.auth.allowed_origins[0],
    url = new URL("/api/task-settings", origin);
  expect((await GET(new Request(url))).status).toBe(401);
  const headers = {
    cookie: `${SESSION_COOKIE}=${sessionToken()}`,
    origin,
    "content-type": "application/json",
  };
  const read = await GET(new Request(url, { headers }));
  expect(read.status).toBe(200);
  const current = (await read.json()).data;
  const patch = await PATCH(
    new Request(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        revision: current.revision,
        policy: { ...current.policy, parallel_imports: 3 },
      }),
    }),
  );
  expect(patch.status).toBe(200);
  const stale = await PATCH(
    new Request(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        revision: current.revision,
        policy: current.policy,
      }),
    }),
  );
  expect((await stale.json()).ok).toBe(false);
  const foreign = await PATCH(
    new Request(url, {
      method: "PATCH",
      headers: { ...headers, origin: "https://untrusted.invalid" },
      body: JSON.stringify({ revision: 2, policy: current.policy }),
    }),
  );
  expect(foreign.status).toBe(403);
});
it("deduplicates repeated requests and simultaneous workers without increasing the selected count", async () => {
  await policy({ ai_enabled: true });
  await publish("kam", ["Only one drink 330 ml"]);
  const calls = provider();
  const idempotency_key = randomUUID();
  const first = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
    product_limit: 1,
    idempotency_key,
  });
  const repeat = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
    product_limit: 1,
    idempotency_key,
  });
  expect(repeat.id).toBe(first.id);
  await Promise.all([executeTask(first.id), executeTask(first.id)]);
  expect(calls.category).toBe(1);
  expect(await task(first.id)).toMatchObject({
    selected: 1,
    processed: 1,
    state: "completed",
  });
});
it("keeps daily local time across the spring daylight-saving transition", () => {
  expect(
    nextOccurrences("0 12 * * *", new Date("2027-03-27T10:00:00Z"), 3),
  ).toEqual([
    "2027-03-27T11:00:00.000Z",
    "2027-03-28T10:00:00.000Z",
    "2027-03-29T10:00:00.000Z",
  ]);
});
it("only a new descriptive product causes automatic work; branch copies reuse completed stages", async () => {
  await policy({
    matching: "automatic",
    categorization: "automatic",
    ai_enabled: true,
    ai_categories: ["soft_drinks"],
  });
  const owner = await start({ kind: "import" });
  await publish("kam", ["Drink memory 330 ml"], owner);
  const calls = provider();
  await automaticTasks();
  const auto = (
    await pool.query<TaskExecution>(
      `SELECT * FROM task_executions WHERE origin='automatic'`,
    )
  ).rows;
  for (const run of auto) {
    await executeTask(run.id);
    await executeTask(run.id);
  }
  await automaticTasks();
  for (const run of (
    await pool.query<TaskExecution>(
      `SELECT * FROM task_executions WHERE origin='automatic' AND state='queued'`,
    )
  ).rows) {
    await executeTask(run.id);
    await executeTask(run.id);
  }
  const total = (
    await pool.query(`SELECT count(*)::int AS n FROM task_executions`)
  ).rows[0].n;
  await publish("kam", ["Drink memory 330 ml"], owner, "second-branch");
  await automaticTasks();
  expect(
    (await pool.query(`SELECT count(*)::int AS n FROM task_executions`)).rows[0]
      .n,
  ).toBe(total);
  expect(calls.category).toBe(1);
});
it("a future manual detail correction receives automatic permission but does not itself call AI", async () => {
  const { read, save } = await import("@/nextsignal/services/product-details");
  await publish("kam", ["Coca Cola 330 ml"]);
  await policy({
    matching: "automatic",
    categorization: "automatic",
    ai_enabled: true,
  });
  const p = (await pool.query(`SELECT id,group_id FROM store_products`))
    .rows[0];
  const details = (await read(p.group_id, p.id))!;
  const result = await save(
    {
      id: details.id,
      member_id: details.member_id,
      snapshot: details.snapshot,
      action: "update",
      changes: { brand: "Coca Cola" },
      note: "Verified manually",
    },
    "tester",
  );
  expect(result.ok).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  expect(
    (
      await pool.query(
        `SELECT auto_match_epoch FROM matching_work WHERE store_product_id=$1`,
        [p.id],
      )
    ).rows[0].auto_match_epoch,
  ).toBe((await readSettings()).epochs.matching);
});
it("rechecks live import permission at the source HTTP boundary", async () => {
  const { fetchBytes } = await import("@/nextsignal/services/http");
  const owner = await start({ kind: "import" }),
    live = await readSettings();
  await withTaskContext(owner, live, async () => {
    await policy({ imports: "off" });
    await expect(fetchBytes(settings.sources.kam.url)).rejects.toThrow("off");
  });
  expect(fetch).not.toHaveBeenCalled();
});
it("transient catalog failures keep their authorized parent alive for durable retries", async () => {
  const { services } = await import("@/nextsignal/services");
  const { SourceError } = await import("@/nextsignal/domain/types");
  const source = await publish("kam", ["Before retry 330 ml"]),
    owner = await start({ kind: "import", source_id: source });
  await executeTask(owner.id);
  const run = (
    await pool.query(`SELECT id FROM runs WHERE task_id=$1`, [owner.id])
  ).rows[0];
  vi.spyOn(services.importers, "retrieve").mockImplementation(
    async function* () {
      throw new SourceError("Provider busy; retry later", true);
    },
  );
  await authorizeRun(run.id, () =>
    app.dispatch("catalog.execute", { run_id: run.id }),
  );
  await executeTask(owner.id);
  expect((await task(owner.id)).state).toBe("running");
  expect((await getRun(run.id)).status).toBe("pending");
});

it("finishes a flaky catalog after more than six failed turns when each turn saved a new page", async () => {
  const { services } = await import("@/nextsignal/services");
  const { SourceError } = await import("@/nextsignal/domain/types");
  const source = await publish("kam", ["Previous catalog product"]);
  const owner = await start({ kind: "import", source_id: source });
  await executeTask(owner.id);
  const run = (
    await pool.query("SELECT id FROM runs WHERE task_id=$1", [owner.id])
  ).rows[0];
  vi.spyOn(services.importers, "retrieve").mockImplementation(
    async function* (_source, cursor) {
      const page = Number(cursor ?? "1");
      yield {
        rows: [pageRow(page)],
        next: page === 9 ? null : String(page + 1),
        total: 9,
        artifact: null,
      };
      if (page < 9)
        throw new SourceError("Next page connection interrupted", true);
    },
  );
  for (let turn = 1; turn <= 9; turn++) {
    await pool.query("UPDATE runs SET next_attempt_at=now() WHERE id=$1", [
      run.id,
    ]);
    await authorizeRun(run.id, () =>
      app.dispatch("catalog.execute", { run_id: run.id }),
    );
    const saved = await getRun(run.id);
    expect(saved.status).toBe(turn < 9 ? "pending" : "success");
    expect(saved.retry_failures).toBe(turn < 9 ? 1 : 0);
    if (turn < 9)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM offers WHERE source_id=$1",
            [source],
          )
        ).rows[0].n,
      ).toBe(1);
  }
  expect((await getRun(run.id)).attempts).toBe(10);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM offers WHERE source_id=$1",
        [source],
      )
    ).rows[0].n,
  ).toBe(9);
  expect(fetch).not.toHaveBeenCalled();
});

it("stops after six failed requests without saved page progress", async () => {
  const { services } = await import("@/nextsignal/services");
  const { SourceError } = await import("@/nextsignal/domain/types");
  const owner = await start({ kind: "discover" });
  await executeTask(owner.id);
  const run = (
    await pool.query("SELECT id FROM runs WHERE task_id=$1", [owner.id])
  ).rows[0];
  vi.spyOn(services.importers, "discover").mockRejectedValue(
    new SourceError("No response", true),
  );
  for (let n = 1; n <= settings.queue.retry_limit + 1; n++) {
    await pool.query("UPDATE runs SET next_attempt_at=now() WHERE id=$1", [
      run.id,
    ]);
    await authorizeRun(run.id, () =>
      app.dispatch("catalog.execute", { run_id: run.id }),
    );
    expect((await getRun(run.id)).retry_failures).toBe(n);
  }
  expect((await getRun(run.id)).status).toBe("failed");
  expect(await claimPendingRuns(10)).toEqual([]);
});

it("yields a large catalog at page boundaries and resumes without spending failure allowance or publishing partial prices", async () => {
  const { services } = await import("@/nextsignal/services");
  const originalLimit = settings.ingestion.pages_per_turn;
  settings.ingestion.pages_per_turn = 2;
  try {
    const source = await publish("kam", ["Previous product"]);
    const owner = await start({ kind: "import", source_id: source });
    await executeTask(owner.id);
    const run = (
      await pool.query("SELECT id FROM runs WHERE task_id=$1", [owner.id])
    ).rows[0];
    vi.spyOn(services.importers, "retrieve").mockImplementation(
      async function* (_source, cursor) {
        for (let n = Number(cursor ?? "1"); n <= 4; n++)
          yield {
            rows: [pageRow(n)],
            next: n === 4 ? null : String(n + 1),
            total: 4,
            artifact: null,
          };
      },
    );
    await authorizeRun(run.id, () =>
      app.dispatch("catalog.execute", { run_id: run.id }),
    );
    expect(await getRun(run.id)).toMatchObject({
      status: "pending",
      retry_failures: 0,
      checkpoint: { cursor: "3", pages_saved: 2 },
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM offers WHERE source_id=$1",
          [source],
        )
      ).rows[0].n,
    ).toBe(1);
    await authorizeRun(run.id, () =>
      app.dispatch("catalog.execute", { run_id: run.id }),
    );
    expect(await getRun(run.id)).toMatchObject({
      status: "success",
      retry_failures: 0,
      checkpoint: { done: true, pages_saved: 4 },
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM offers WHERE source_id=$1",
          [source],
        )
      ).rows[0].n,
    ).toBe(4);
  } finally {
    settings.ingestion.pages_per_turn = originalLimit;
  }
});

it("gives a never-started catalog a turn before a due retry in the same store", async () => {
  const { waitForRetry } = await import("@/nextsignal/services/tasks");
  const one = await publish("kam", ["First branch"], undefined, "first");
  const two = await publish("kam", ["Second branch"], undefined, "second");
  const first = await start({ kind: "import", source_id: one });
  await executeTask(first.id);
  const claim = (await claimPendingRuns(1))[0];
  await pool.query("UPDATE runs SET status='running',attempts=1 WHERE id=$1", [
    claim.id,
  ]);
  await waitForRetry(claim.id, new Error("Temporary network failure"));
  await releaseDispatch(claim.id, claim.dispatch_token);
  await pool.query("UPDATE runs SET next_attempt_at=now() WHERE id=$1", [
    claim.id,
  ]);
  const second = await start({ kind: "import", source_id: two });
  await executeTask(second.id);
  const next = (await claimPendingRuns(1))[0];
  expect((await getRun(next.id)).source_id).toBe(two);
  expect((await getRun(next.id)).attempts).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

function interruptedSourceResponse() {
  let first = true;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(new TextEncoder().encode('[{"Id":73'));
        } else {
          controller.error(
            new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError",
            ),
          );
        }
      },
    }),
    { headers: { "content-length": "100" } },
  );
}

it("waits for an automatically queued empty-catalog confirmation without reporting a failed catalog", async () => {
  const { services } = await import("@/nextsignal/services");
  const source = await publish("kam", ["Existing product"]);
  const owner = await start({ kind: "import", source_id: source });
  await executeTask(owner.id);
  const run = (
    await pool.query("SELECT id FROM runs WHERE task_id=$1", [owner.id])
  ).rows[0];
  vi.spyOn(services.importers, "retrieve").mockImplementation(
    async function* () {
      yield { rows: [], next: null, total: 0, artifact: null };
    },
  );
  await authorizeRun(run.id, () =>
    app.dispatch("catalog.execute", { run_id: run.id }),
  );
  expect((await getRun(run.id)).status).toBe("quarantined");
  await executeTask(owner.id);
  expect((await task(owner.id)).state).toBe("running");
  expect((await task(owner.id)).reason).not.toContain("failed catalog");
  expect(
    (
      await pool.query(
        "SELECT * FROM runs WHERE task_id=$1 AND status='pending' AND checkpoint->>'confirmation_of'=$2",
        [owner.id, run.id],
      )
    ).rowCount,
  ).toBe(1);
});

it("finishes a healthy partial catalog before opening another catalog in the same store", async () => {
  const one = await publish("kam", ["Partial branch"], undefined, "partial");
  const two = await publish("kam", ["Fresh branch"], undefined, "untouched");
  const first = await start({ kind: "import", source_id: one });
  await executeTask(first.id);
  const partial = (
    await pool.query("SELECT id FROM runs WHERE task_id=$1", [first.id])
  ).rows[0];
  await pool.query(
    'UPDATE runs SET attempts=2,checkpoint=checkpoint||\'{"done":false,"cursor":"26","pages_saved":25}\' WHERE id=$1',
    [partial.id],
  );
  const second = await start({ kind: "import", source_id: two });
  await executeTask(second.id);
  const selected = (await claimPendingRuns(1))[0];
  expect((await getRun(selected.id)).source_id).toBe(one);
  expect((await getRun(partial.id)).checkpoint).toMatchObject({
    done: false,
    cursor: "26",
    pages_saved: 25,
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("publishes a fully downloaded catalog before starting another fresh download in the same store", async () => {
  const source = await publish("kam", ["First branch"], undefined, "ready");
  const otherSource = await publish(
    "kam",
    ["Second branch"],
    undefined,
    "fresh",
  );
  const owner = await start({ kind: "import", source_id: source });
  await executeTask(owner.id);
  const first = (
    await pool.query("SELECT id FROM runs WHERE task_id=$1", [owner.id])
  ).rows[0];
  await pool.query(
    "UPDATE runs SET attempts=4,checkpoint=checkpoint||'{\"done\":true}' WHERE id=$1",
    [first.id],
  );
  const other = await start({ kind: "import", source_id: otherSource });
  await executeTask(other.id);
  expect((await claimPendingRuns(1))[0].id).toBe(first.id);
});

it("retries discovery body timeouts without publishing a partial catalog list", async () => {
  const owner = await start({ kind: "discover" });
  await executeTask(owner.id);
  const run = (
    await pool.query(`SELECT id FROM runs WHERE task_id=$1`, [owner.id])
  ).rows[0];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => interruptedSourceResponse()),
  );
  await authorizeRun(run.id, () =>
    app.dispatch("catalog.execute", { run_id: run.id }),
  );
  const savedRun = await getRun(run.id);
  expect(savedRun.status).toBe("pending");
  const savedError = (
    await pool.query<{ error: string }>("SELECT error FROM runs WHERE id=$1", [
      run.id,
    ])
  ).rows[0].error;
  expect(savedError).toContain("Timed out downloading from kam.com.mk");
  expect(savedError).toContain("9 of 100 bytes received");
  await executeTask(owner.id);
  expect((await task(owner.id)).state).toBe("running");
  expect(
    (await pool.query(`SELECT count(*)::int AS n FROM sources`)).rows[0].n,
  ).toBe(0);
  const event = (
    await pool.query(
      `SELECT data FROM logs WHERE data->>'event'='catalog.retry.scheduled' AND run_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [run.id],
    )
  ).rows[0];
  expect(event.data).toMatchObject({
    received_bytes: 9,
    expected_bytes: 100,
    retryable: true,
  });
});

it("retries an HTTP-200 upstream outage and discovers the store list after recovery without replacing saved prices", async () => {
  const source = await publish("stokomak", ["Milk 1L"]);
  const owner = await start({ kind: "discover", retailers: ["stokomak"] });
  await executeTask(owner.id);
  const run = (
    await pool.query("SELECT id FROM runs WHERE task_id=$1", [owner.id])
  ).rows[0];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          "\uFEFFError fetching organizations: Failed to connect to 172.16.19.26 port 80: Timed out",
        ),
    ),
  );
  await authorizeRun(run.id, () =>
    app.dispatch("catalog.execute", { run_id: run.id }),
  );
  expect(await getRun(run.id)).toMatchObject({
    status: "pending",
    retry_failures: 1,
  });
  expect(
    (
      await pool.query("SELECT next_attempt_at FROM runs WHERE id=$1", [run.id])
    ).rows[0].next_attempt_at.getTime(),
  ).toBeGreaterThan(Date.now());
  const event = (
    await pool.query(
      "SELECT data,error,message FROM logs WHERE run_id=$1 AND data->>'event'='catalog.retry.scheduled' ORDER BY created_at DESC LIMIT 1",
      [run.id],
    )
  ).rows[0];
  expect(event.message).toContain("Store catalog list unavailable");
  expect(event.data).toMatchObject({
    phase: "provider_response",
    status: 200,
    provider_operation: "organizations",
    provider_failure: "connection_timeout",
    consecutive_failures: 1,
  });
  expect(JSON.stringify(event)).not.toContain("172.16.19.26");
  expect(
    (
      await pool.query("SELECT active,row_count FROM sources WHERE id=$1", [
        source,
      ])
    ).rows[0],
  ).toMatchObject({ active: true, row_count: 1 });
  expect(
    (await pool.query("SELECT price FROM offers WHERE source_id=$1", [source]))
      .rows[0].price,
  ).toBe("50.00");
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(
      '<select name="org"><option value="one">Store One</option></select>',
    ),
  );
  await pool.query(
    "UPDATE runs SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  await authorizeRun(run.id, () =>
    app.dispatch("catalog.execute", { run_id: run.id }),
  );
  expect((await getRun(run.id)).status).toBe("success");
  await executeTask(owner.id);
  expect((await task(owner.id)).state).toBe("completed");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM runs WHERE task_id=$1 AND kind='catalog'",
        [owner.id],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (await pool.query("SELECT price FROM offers WHERE source_id=$1", [source]))
      .rows[0].price,
  ).toBe("50.00");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("shows the actual discovery failure after exhausting its original retry allowance", async () => {
  const owner = await start({ kind: "discover" });
  await executeTask(owner.id);
  const run = (
    await pool.query(
      `UPDATE runs SET attempts=$2,retry_failures=$2 WHERE task_id=$1 RETURNING id`,
      [owner.id, settings.queue.retry_limit],
    )
  ).rows[0];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => interruptedSourceResponse()),
  );
  await authorizeRun(run.id, () =>
    app.dispatch("catalog.execute", { run_id: run.id }),
  );
  expect((await getRun(run.id)).status).toBe("failed");
  await executeTask(owner.id);
  expect(await task(owner.id)).toMatchObject({
    state: "failed",
    reason: expect.stringContaining("KAM: Timed out downloading"),
  });
});

it("publishes a task's newly created discovery work without another scheduler tick", async () => {
  const { taskJob } = await import("@/nextsignal/processes/distributed/tasks");
  const { services } = await import("@/nextsignal/services");
  const { config } = await import("@/nextsignal/config");
  const { loggerAdapter } = await import("@/nextsignal/adapters/logger");
  const { ok } = await import("@gotch/nextsignal");
  const owner = await start({ kind: "discover" });
  const other = await start({ kind: "discover", retailers: ["spar"] });
  await executeTask(other.id);
  const dispatch = vi.fn(async () => ok());
  const ctx = {
    services,
    config,
    logger: loggerAdapter,
    mediator: { dispatch },
    metadata: { processName: "tasks.job", correlationId: randomUUID() },
  } as unknown as Parameters<typeof taskJob.work>[0];
  await taskJob.work(ctx, { task_id: owner.id });
  const runs = (
    await pool.query(`SELECT id,status FROM runs WHERE task_id=$1`, [owner.id])
  ).rows;
  expect(runs).toHaveLength(1);
  expect(runs[0].status).toBe("queued");
  expect(dispatch).toHaveBeenCalledExactlyOnceWith("catalog.download", {
    run_id: runs[0].id,
    dispatch_token: expect.any(String),
  });
  expect(await pendingRuns(50, other.id)).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
});

async function batchWorkerContext(dispatch: ReturnType<typeof vi.fn>) {
  const { taskJob } = await import("@/nextsignal/processes/distributed/tasks");
  const { services } = await import("@/nextsignal/services");
  const { config } = await import("@/nextsignal/config");
  const { loggerAdapter } = await import("@/nextsignal/adapters/logger");
  return {
    services,
    config,
    logger: loggerAdapter,
    mediator: { dispatch },
    metadata: { processName: "tasks.job", correlationId: randomUUID() },
  } as unknown as Parameters<typeof taskJob.work>[0];
}

it.each([3, null])(
  "continues the same categorized task immediately, preserving its product limit of %s",
  async (limit) => {
    await policy({ ai_enabled: true, batch_size: 2 });
    await publish("kam", [
      "Drink A 330 ml",
      "Drink B 330 ml",
      "Drink C 330 ml",
      "Drink D 330 ml",
    ]);
    const calls = provider();
    const owner = await start({
      kind: "categorize",
      use_ai: true,
      max_cost_usd: 0.1,
      product_limit: limit,
    });
    const other = await start({ kind: "match" });
    const { taskJob } =
      await import("@/nextsignal/processes/distributed/tasks");
    const { ok } = await import("@gotch/nextsignal");
    const dispatch = vi.fn(async (_name: string, _input: { task_id: string }) =>
      ok(),
    );
    const ctx = await batchWorkerContext(dispatch);
    await taskJob.work(ctx, { task_id: owner.id });
    expect(await task(owner.id)).toMatchObject({
      state: "queued",
      processed: 2,
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("tasks.job", {
      task_id: owner.id,
    });
    expect((await task(owner.id)).dispatch_until).not.toBeNull();
    expect((await task(other.id)).dispatch_until).toBeNull();
    // Simulate only messages published by the worker, without a scheduler tick.
    for (let i = 0; i < 3 && (await task(owner.id)).state === "queued"; i++)
      await taskJob.work(ctx, { task_id: owner.id });
    expect(await task(owner.id)).toMatchObject({
      state: "completed",
      processed: limit ?? 4,
      selected: limit ?? 4,
    });
    expect(calls).toEqual({ category: limit ?? 4, match: 0 });
    expect(
      dispatch.mock.calls.every(
        ([name, input]) => name === "tasks.job" && input.task_id === owner.id,
      ),
    ).toBe(true);
    const publications = dispatch.mock.calls.length;
    await taskJob.work(ctx, { task_id: owner.id });
    expect(dispatch).toHaveBeenCalledTimes(publications);
  },
);

it("continues code-only matching with automation and AI off without starting other tasks", async () => {
  await policy({ batch_size: 1 });
  await publish("kam", [
    "First drink 330 ml",
    "Second drink 330 ml",
    "Third drink 330 ml",
  ]);
  const owner = await start({ product_limit: 2 });
  const { taskJob } = await import("@/nextsignal/processes/distributed/tasks");
  const { ok } = await import("@gotch/nextsignal");
  const dispatch = vi.fn(async () => ok());
  const ctx = await batchWorkerContext(dispatch);
  await taskJob.work(ctx, { task_id: owner.id });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith("tasks.job", {
    task_id: owner.id,
  });
  await taskJob.work(ctx, { task_id: owner.id });
  expect(await task(owner.id)).toMatchObject({
    state: "completed",
    selected: 2,
    processed: 2,
  });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(
    (await pool.query("SELECT count(*)::int n FROM task_executions")).rows[0].n,
  ).toBe(1);
});

it("checks removed AI permission before a continued batch and does not enqueue paused work", async () => {
  await policy({ ai_enabled: true, batch_size: 1 });
  await publish("kam", ["First drink 330 ml", "Second drink 330 ml"]);
  const calls = provider();
  const owner = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
    product_limit: null,
  });
  const { taskJob } = await import("@/nextsignal/processes/distributed/tasks");
  const { ok } = await import("@gotch/nextsignal");
  const dispatch = vi.fn(async () => ok());
  const ctx = await batchWorkerContext(dispatch);
  await taskJob.work(ctx, { task_id: owner.id });
  expect(dispatch).toHaveBeenCalledTimes(1);
  await policy({ ai_enabled: false });
  await taskJob.work(ctx, { task_id: owner.id });
  expect(await task(owner.id)).toMatchObject({ state: "paused", processed: 1 });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(calls).toEqual({ category: 1, match: 0 });
});

it("does not enqueue another product batch after reaching the reviewed request allowance", async () => {
  await policy({ ai_enabled: true, batch_size: 2, task_request_limit: 1 });
  await publish("kam", ["First drink 330 ml", "Second drink 330 ml"]);
  const calls = provider();
  const owner = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
    product_limit: null,
  });
  const { taskJob } = await import("@/nextsignal/processes/distributed/tasks");
  const { ok } = await import("@gotch/nextsignal");
  const dispatch = vi.fn(async () => ok());
  await taskJob.work(await batchWorkerContext(dispatch), { task_id: owner.id });
  expect(await task(owner.id)).toMatchObject({ state: "paused", processed: 1 });
  expect(dispatch).not.toHaveBeenCalled();
  expect(calls).toEqual({ category: 1, match: 0 });
});

it("recovers a failed continuation publication without repeating completed AI calls", async () => {
  await policy({ ai_enabled: true, batch_size: 1 });
  await publish("kam", ["First drink 330 ml", "Second drink 330 ml"]);
  const calls = provider();
  const owner = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
    product_limit: 2,
  });
  const { taskJob, dispatchTasks } =
    await import("@/nextsignal/processes/distributed/tasks");
  const { ok } = await import("@gotch/nextsignal");
  const dispatch = vi.fn<() => Promise<ReturnType<typeof ok>>>(async () => {
    throw new Error("Queue unavailable");
  });
  const ctx = await batchWorkerContext(dispatch);
  await expect(taskJob.work(ctx, { task_id: owner.id })).rejects.toThrow(
    "Queue unavailable",
  );
  expect(await task(owner.id)).toMatchObject({
    state: "queued",
    processed: 1,
    dispatch_until: null,
  });
  dispatch.mockImplementation(async () => ok());
  await dispatchTasks(ctx, owner.id);
  await taskJob.work(ctx, { task_id: owner.id });
  expect(await task(owner.id)).toMatchObject({
    state: "completed",
    processed: 2,
  });
  expect(calls).toEqual({ category: 2, match: 0 });
});

it("keeps source size limits permanent rather than retrying them as network failures", async () => {
  const { fetchBytes } = await import("@/nextsignal/services/http");
  const previous = settings.http.max_bytes;
  settings.http.max_bytes = 2;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("long response")),
  );
  try {
    await expect(
      fetchBytes(settings.sources.kam.api_url!),
    ).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("byte limit"),
    });
  } finally {
    settings.http.max_bytes = previous;
  }
});

it("reports connection timeout codes and uses the source-specific dispatcher", async () => {
  const { fetchBytes } = await import("@/nextsignal/services/http");
  const { Agent } = await import("undici");
  const cause = Object.assign(new Error("Connect Timeout Error"), {
    code: "UND_ERR_CONNECT_TIMEOUT",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("fetch failed", { cause });
    }),
  );
  const failure = await fetchBytes(settings.sources.stokomak.url).catch(
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({
    retryable: true,
    message: expect.stringContaining("UND_ERR_CONNECT_TIMEOUT"),
  });
  expect(fetch).toHaveBeenCalledWith(
    settings.sources.stokomak.url,
    expect.objectContaining({
      dispatcher: expect.any(Agent),
      signal: expect.any(AbortSignal),
    }),
  );
  expect(failure).toMatchObject({
    diagnostics: {
      error_code: "UND_ERR_CONNECT_TIMEOUT",
      phase: "connection",
      received_bytes: 0,
      connect_timeout_ms: settings.http.connect_timeout_ms,
    },
  });
});

it("retains the underlying socket error instead of only reporting fetch failed", async () => {
  const { fetchBytes } = await import("@/nextsignal/services/http");
  const socketError = Object.assign(new Error("Connection reset by peer"), {
    code: "ECONNRESET",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new AggregateError([socketError], "Connection attempts failed"),
      });
    }),
  );
  await expect(fetchBytes(settings.sources.kam.url)).rejects.toMatchObject({
    retryable: true,
    message: expect.stringContaining("[ECONNRESET] Connection reset by peer"),
  });
});

it("queues a newly reviewed API task immediately without publishing other waiting tasks", async () => {
  const { taskStart } = await import("@/nextsignal/processes/api/tasks");
  const { services } = await import("@/nextsignal/services");
  const { config } = await import("@/nextsignal/config");
  const { loggerAdapter } = await import("@/nextsignal/adapters/logger");
  const { ok } = await import("@gotch/nextsignal");
  const previous = await start({ kind: "discover", product_limit: null });
  const input = { ...previous.options, idempotency_key: randomUUID() };
  const dispatch = vi.fn(async () => ok());
  const ctx = {
    services,
    config,
    logger: loggerAdapter,
    mediator: { dispatch },
    metadata: { processName: "tasks.start", correlationId: randomUUID() },
  } as unknown as Parameters<typeof taskStart.handle>[0];
  const result = await taskStart.handle(ctx, input);
  expect(result.ok).toBe(true);
  const row = (
    await pool.query(
      `SELECT id,dispatch_until,state FROM task_executions WHERE idempotency_key=$1`,
      [input.idempotency_key],
    )
  ).rows[0];
  expect(dispatch).toHaveBeenCalledExactlyOnceWith("tasks.job", {
    task_id: row.id,
  });
  expect(row.state).toBe("queued");
  expect(row.dispatch_until).not.toBeNull();
  expect(
    (
      await pool.query(
        `SELECT dispatch_until FROM task_executions WHERE id=$1`,
        [previous.id],
      )
    ).rows[0].dispatch_until,
  ).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps an accepted task recoverable when immediate queue publication fails", async () => {
  const { taskStart } = await import("@/nextsignal/processes/api/tasks");
  const { dispatchTasks } =
    await import("@/nextsignal/processes/distributed/tasks");
  const { services } = await import("@/nextsignal/services");
  const { config } = await import("@/nextsignal/config");
  const { loggerAdapter } = await import("@/nextsignal/adapters/logger");
  const { ok } = await import("@gotch/nextsignal");
  const previous = await start({ kind: "discover", product_limit: null });
  const input = { ...previous.options, idempotency_key: randomUUID() };
  const dispatch = vi.fn<() => Promise<ReturnType<typeof ok>>>(async () => {
    throw new Error("Queue unavailable");
  });
  const ctx = {
    services,
    config,
    logger: loggerAdapter,
    mediator: { dispatch },
    metadata: { processName: "tasks.start", correlationId: randomUUID() },
  } as unknown as Parameters<typeof taskStart.handle>[0];
  const result = await taskStart.handle(ctx, input);
  expect(result.ok).toBe(true);
  const row = (
    await pool.query(
      `SELECT id,dispatch_until,state FROM task_executions WHERE idempotency_key=$1`,
      [input.idempotency_key],
    )
  ).rows[0];
  expect(row).toMatchObject({ state: "queued", dispatch_until: null });
  dispatch.mockImplementation(async () => ok());
  await dispatchTasks(ctx, row.id);
  expect(dispatch).toHaveBeenLastCalledWith("tasks.job", { task_id: row.id });
  expect(fetch).not.toHaveBeenCalled();
});

it("counts imported catalogs separately from discovery steps", async () => {
  const { listTasks } = await import("@/nextsignal/services/tasks");
  const owner = await start({ kind: "import", product_limit: null });
  const source = await publish("kam", ["Imported product 330 ml"], owner);
  const published = (
    await pool.query(
      `SELECT id FROM runs WHERE source_id=$1 AND kind='catalog' AND status='success'`,
      [source],
    )
  ).rows[0];
  await pool.query(`UPDATE runs SET task_id=$2 WHERE id=$1`, [
    published.id,
    owner.id,
  ]);
  await pool.query(
    `INSERT INTO runs(kind,retailer,status,task_id) VALUES('discover','kam','success',$1)`,
    [owner.id],
  );
  const rows = await listTasks(1, 10);
  expect(rows.rows.find((row) => row.id === owner.id).published_catalogs).toBe(
    1,
  );
});

it("reserves import capacity before publication and rotates stores after a failed attempt", async () => {
  await policy({ parallel_imports: 1, per_store_downloads: 1 });
  const { waitForRetry } = await import("@/nextsignal/services/tasks");
  const owner = await start({
    kind: "discover",
    retailers: ["stokomak", "kam", "spar"],
  });
  await executeTask(owner.id);
  const first = (await claimPendingRuns(50))[0];
  expect(first).toBeDefined();
  expect(await claimPendingRuns(50)).toEqual([]);
  await pool.query(`UPDATE runs SET status='running',attempts=1 WHERE id=$1`, [
    first.id,
  ]);
  const retry = await waitForRetry(first.id, new Error("Connection timeout"));
  if (!retry.retry_scheduled)
    throw new Error("First failure must be retryable");
  expect(Date.parse(retry.next_attempt_at)).toBeGreaterThan(Date.now());
  await releaseDispatch(first.id, first.dispatch_token);
  const second = (await claimPendingRuns(50))[0];
  expect(second.retailer).not.toBe(first.retailer);
  await pool.query(`UPDATE runs SET status='success' WHERE id=$1`, [second.id]);
  await releaseDispatch(second.id, second.dispatch_token);
  // Even a now-due retry cannot jump ahead of a store never given its turn.
  await pool.query(
    `UPDATE runs SET next_attempt_at=now()-interval '1 second' WHERE id=$1`,
    [first.id],
  );
  const third = (await claimPendingRuns(50))[0];
  expect(new Set([first.retailer, second.retailer, third.retailer]).size).toBe(
    3,
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("concurrent dispatchers cannot oversubscribe the global limit or the same store", async () => {
  await policy({ parallel_imports: 2 });
  const one = await start({
    kind: "discover",
    retailers: ["kam", "spar", "vero"],
  });
  const two = await start({
    kind: "discover",
    retailers: ["kam", "spar", "vero"],
  });
  await executeTask(one.id);
  await executeTask(two.id);
  const results = (
    await Promise.all([claimPendingRuns(50), claimPendingRuns(50)])
  ).flat();
  expect(results).toHaveLength(2);
  expect(new Set(results.map((row) => row.retailer)).size).toBe(2);
  expect(
    (await pool.query(`SELECT * FROM runs WHERE dispatch_token IS NOT NULL`))
      .rowCount,
  ).toBe(2);
});

it("skips a cooling store without consuming attempts or blocking another store", async () => {
  const owner = await start({
    kind: "discover",
    retailers: ["stokomak", "kam"],
  });
  await executeTask(owner.id);
  await pool.query(
    `INSERT INTO host_limits(host,next_at,cooldown_until) VALUES($1,now(),now()+interval '10 minutes')`,
    [new URL(settings.sources.stokomak.url).host],
  );
  const claimed = await claimPendingRuns(50);
  expect(claimed).toHaveLength(1);
  expect(claimed[0].retailer).toBe("kam");
  expect(
    (
      await pool.query(
        `SELECT attempts,status FROM runs WHERE task_id=$1 AND retailer='stokomak'`,
        [owner.id],
      )
    ).rows[0],
  ).toEqual({ attempts: 0, status: "pending" });
});

it("replaces an expired queue lease and rejects the old payload", async () => {
  const owner = await start({ kind: "discover" });
  await executeTask(owner.id);
  const first = (await claimPendingRuns(50))[0];
  const lease = (
    await pool.query<{ dispatch_until: Date }>(
      `SELECT dispatch_until FROM runs WHERE id=$1`,
      [first.id],
    )
  ).rows[0];
  expect(lease.dispatch_until.getTime() - Date.now()).toBeGreaterThan(0);
  expect(lease.dispatch_until.getTime() - Date.now()).toBeLessThanOrEqual(
    settings.queue.dispatch_lease_seconds * 1000,
  );
  await pool.query(
    `UPDATE runs SET dispatch_until=now()-interval '1 second' WHERE id=$1`,
    [first.id],
  );
  const second = (await claimPendingRuns(50))[0];
  expect(second.id).toBe(first.id);
  expect(second.dispatch_token).not.toBe(first.dispatch_token);
  const execute = vi.fn(async () => true);
  expect(
    await authorizeRun(first.id, execute, first.dispatch_token),
  ).toBeNull();
  expect(execute).not.toHaveBeenCalled();
  expect(
    (
      await pool.query(`SELECT dispatch_token FROM runs WHERE id=$1`, [
        second.id,
      ])
    ).rows[0].dispatch_token,
  ).toBe(second.dispatch_token);
});

it("a tokenless old queue delivery performs no import", async () => {
  const { downloadJob: runJob } =
    await import("@/nextsignal/processes/distributed/jobs");
  const { services } = await import("@/nextsignal/services");
  const { config } = await import("@/nextsignal/config");
  const { loggerAdapter } = await import("@/nextsignal/adapters/logger");
  const owner = await start({ kind: "discover" });
  await executeTask(owner.id);
  const run = (await pendingRuns(50))[0];
  const dispatch = vi.fn();
  const ctx = {
    services,
    config,
    logger: loggerAdapter,
    mediator: { dispatch },
    metadata: { processName: "catalog.job", correlationId: randomUUID() },
  } as unknown as Parameters<typeof runJob.work>[0];
  expect((await runJob.work(ctx, { run_id: run.id })).ok).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
  expect((await getRun(run.id)).attempts).toBe(0);
});

it("recovers interrupted dispatch without retrying completed catalogs or resetting the retry wait", async () => {
  const { recoverAuthorizedWork } = await import("@/nextsignal/services/tasks");
  const owner = await start({ kind: "discover", retailers: ["kam", "spar"] });
  await executeTask(owner.id);
  const first = (await claimPendingRuns(1))[0];
  await pool.query(
    `UPDATE runs SET status='running',attempts=1,next_attempt_at=now()+interval '5 minutes',checkpoint='{"cursor":"2"}' WHERE id=$1`,
    [first.id],
  );
  const other = (
    await pool.query(`SELECT id FROM runs WHERE task_id=$1 AND id<>$2`, [
      owner.id,
      first.id,
    ])
  ).rows[0];
  await pool.query(`UPDATE runs SET status='success',attempts=1 WHERE id=$1`, [
    other.id,
  ]);
  await recoverAuthorizedWork();
  expect(await getRun(first.id)).toMatchObject({
    status: "pending",
    attempts: 1,
    checkpoint: { cursor: "2" },
  });
  expect(await claimPendingRuns(50)).toEqual([]);
  expect(await getRun(other.id)).toMatchObject({
    status: "success",
    attempts: 1,
  });
});

it("explicit resume retries failed catalogs from saved pages and keeps successful catalogs untouched", async () => {
  const source = await publish("kam", ["Saved 330 ml"]);
  const owner = await start({ kind: "import", source_id: source });
  await executeTask(owner.id);
  const failed = (
    await pool.query(`SELECT id FROM runs WHERE task_id=$1`, [owner.id])
  ).rows[0];
  await pool.query(
    `UPDATE runs SET status='failed',attempts=$2,checkpoint=checkpoint||'{"cursor":"2","done":false}',error='Connection timeout' WHERE id=$1`,
    [failed.id, settings.queue.retry_limit + 1],
  );
  await pool.query(
    `INSERT INTO staging(run_id,key,data) VALUES($1,'saved-page','{"name":"Saved first page"}')`,
    [failed.id],
  );
  const success = await createRun("catalog", "kam", source, null);
  await pool.query(
    `UPDATE runs SET task_id=$2,status='success',attempts=1 WHERE id=$1`,
    [success.id, owner.id],
  );
  await pool.query(`UPDATE task_executions SET state='paused' WHERE id=$1`, [
    owner.id,
  ]);
  await controlTask(
    owner.id,
    "resume",
    (await readSettings()).revision,
    "tester",
  );
  const replacement = (
    await pool.query(
      `SELECT * FROM runs WHERE task_id=$1 AND checkpoint->>'retry_of'=$2`,
      [owner.id, failed.id],
    )
  ).rows[0];
  expect(replacement).toMatchObject({
    status: "pending",
    attempts: 0,
    checkpoint: { cursor: "2", retry_of: failed.id },
  });
  expect(
    (
      await pool.query(`SELECT key,data FROM staging WHERE run_id=$1`, [
        replacement.id,
      ])
    ).rows,
  ).toEqual([{ key: "saved-page", data: { name: "Saved first page" } }]);
  expect(await getRun(success.id)).toMatchObject({
    status: "success",
    attempts: 1,
  });
  expect(await getRun(failed.id)).toMatchObject({
    status: "superseded",
    attempts: settings.queue.retry_limit + 1,
  });
  expect(
    (await pool.query(`SELECT error FROM runs WHERE id=$1`, [failed.id]))
      .rows[0].error,
  ).toBe("Connection timeout");
  expect(fetch).not.toHaveBeenCalled();
});

it("pause and resume replace dispatch authorization without releasing old queue payloads", async () => {
  const owner = await start({ kind: "discover" });
  await executeTask(owner.id);
  const first = (await claimPendingRuns(1))[0];
  const revision = (await readSettings()).revision;
  await controlTask(owner.id, "pause", revision, "tester");
  expect(await claimPendingRuns(50)).toEqual([]);
  await controlTask(owner.id, "resume", revision, "tester");
  const second = (await claimPendingRuns(1))[0];
  expect(second.dispatch_token).not.toBe(first.dispatch_token);
  expect(
    await authorizeRun(first.id, vi.fn(), first.dispatch_token),
  ).toBeNull();
});

it("releases every unpublished reservation when queue publication fails", async () => {
  const { dispatchPending } =
    await import("@/nextsignal/processes/distributed/jobs");
  const { services } = await import("@/nextsignal/services");
  const { config } = await import("@/nextsignal/config");
  const { loggerAdapter } = await import("@/nextsignal/adapters/logger");
  await policy({ parallel_imports: 2 });
  const owner = await start({ kind: "discover", retailers: ["kam", "spar"] });
  await executeTask(owner.id);
  const dispatch = vi.fn(async () => {
    throw new Error("Queue unavailable");
  });
  const ctx = {
    services,
    config,
    logger: loggerAdapter,
    mediator: { dispatch },
    metadata: { processName: "catalog.tick", correlationId: randomUUID() },
  } as unknown as Parameters<typeof dispatchPending>[0];
  await expect(dispatchPending(ctx)).rejects.toThrow("Queue unavailable");
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(
    (
      await pool.query(
        `SELECT * FROM runs WHERE status='pending' AND dispatch_token IS NULL`,
      )
    ).rowCount,
  ).toBe(2);
});

it("a lower live parallel limit stops already queued excess work before execution", async () => {
  await policy({ parallel_imports: 2 });
  const owner = await start({ kind: "discover", retailers: ["kam", "spar"] });
  await executeTask(owner.id);
  const claims = await claimPendingRuns(50);
  expect(claims).toHaveLength(2);
  await policy({ parallel_imports: 1 });
  const later = (
    await pool.query(
      `SELECT id FROM runs WHERE task_id=$1 ORDER BY dispatched_at DESC,id DESC LIMIT 1`,
      [owner.id],
    )
  ).rows[0];
  const claim = claims.find((run) => run.id === later.id)!;
  const execute = vi.fn(async () => true);
  expect(
    await authorizeRun(claim.id, execute, claim.dispatch_token),
  ).toBeNull();
  expect(execute).not.toHaveBeenCalled();
  expect((await getRun(claim.id)).status).toBe("pending");
});

it("a second worker cannot recover a live delivery before its run has started", async () => {
  const { recoverAuthorizedWork } = await import("@/nextsignal/services/tasks");
  const owner = await start({ kind: "discover" });
  await executeTask(owner.id);
  const claim = (await claimPendingRuns(1))[0];
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const delivery = authorizeRun(
    claim.id,
    async () => {
      entered();
      await gate;
      return true;
    },
    claim.dispatch_token,
  );
  await started;
  try {
    await recoverAuthorizedWork();
    expect(
      (
        await pool.query(`SELECT status,dispatch_token FROM runs WHERE id=$1`, [
          claim.id,
        ])
      ).rows[0],
    ).toEqual({ status: "queued", dispatch_token: claim.dispatch_token });
    expect(await claimPendingRuns(50)).toEqual([]);
  } finally {
    finish();
    await delivery;
  }
});

it("keeps retry snapshots older than later published catalogs even when the retry was requested later", async () => {
  const { supersedeObsolete } =
    await import("@/nextsignal/services/run-repository");
  const source = await publish("kam", ["Original 330 ml"]);
  await pool.query(
    `UPDATE runs SET created_at=now()-interval '3 hours' WHERE id=(SELECT published_run FROM sources WHERE id=$1)`,
    [source],
  );
  const owner = await start({ kind: "import", source_id: source });
  await executeTask(owner.id);
  const previous = (
    await pool.query(`SELECT id FROM runs WHERE task_id=$1`, [owner.id])
  ).rows[0];
  await pool.query(
    `UPDATE runs SET status='failed',created_at=now()-interval '2 hours' WHERE id=$1`,
    [previous.id],
  );
  await controlTask(
    owner.id,
    "pause",
    (await readSettings()).revision,
    "tester",
  );
  await controlTask(
    owner.id,
    "resume",
    (await readSettings()).revision,
    "tester",
  );
  const replacement = (
    await pool.query(`SELECT id FROM runs WHERE checkpoint->>'retry_of'=$1`, [
      previous.id,
    ])
  ).rows[0];
  const fresh = await createRun("catalog", "kam", source, null);
  await pool.query(
    `UPDATE runs SET status='success',created_at=now()-interval '1 hour' WHERE id=$1`,
    [fresh.id],
  );
  await pool.query(`UPDATE sources SET published_run=$2 WHERE id=$1`, [
    source,
    fresh.id,
  ]);
  expect(await supersedeObsolete(await getRun(replacement.id))).toMatchObject({
    status: "superseded",
  });
  expect(await publishCatalog(await getRun(replacement.id))).toMatchObject({
    status: "superseded",
  });
  expect(
    (
      await pool.query(`SELECT published_run FROM sources WHERE id=$1`, [
        source,
      ])
    ).rows[0].published_run,
  ).toBe(fresh.id);
});

it("maintenance preserves paused and explicitly retryable catalog pages, artifacts and checkpoints", async () => {
  const { maintenance } = await import("@/nextsignal/services/scheduling");
  const source = await publish("kam", ["Original 330 ml"]);
  const owner = await start({ kind: "import", source_id: source });
  await executeTask(owner.id);
  const interrupted = (
    await pool.query(`SELECT id FROM runs WHERE task_id=$1`, [owner.id])
  ).rows[0];
  await pool.query(
    `UPDATE runs SET status='failed',finished_at=now()-$2*interval '1 hour',checkpoint=checkpoint||'{"cursor":"2"}' WHERE id=$1`,
    [interrupted.id, settings.ingestion.staging_hours + 1],
  );
  await pool.query(
    `INSERT INTO staging(run_id,key,data) VALUES($1,'saved','{}')`,
    [interrupted.id],
  );
  await pool.query(
    `INSERT INTO artifacts(source_id,run_id,content,created_at) VALUES($1,$2,'saved',now()-$3*interval '1 hour')`,
    [source, interrupted.id, settings.ingestion.artifact_hours + 1],
  );
  await pool.query(`UPDATE task_executions SET state='paused' WHERE id=$1`, [
    owner.id,
  ]);
  await maintenance();
  expect(
    (
      await pool.query(`SELECT * FROM staging WHERE run_id=$1`, [
        interrupted.id,
      ])
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(`SELECT * FROM artifacts WHERE run_id=$1`, [
        interrupted.id,
      ])
    ).rowCount,
  ).toBe(1);
  expect((await getRun(interrupted.id)).checkpoint.cursor).toBe("2");
  await pool.query(`UPDATE task_executions SET state='failed' WHERE id=$1`, [
    owner.id,
  ]);
  await maintenance();
  expect(
    (
      await pool.query(`SELECT * FROM staging WHERE run_id=$1`, [
        interrupted.id,
      ])
    ).rowCount,
  ).toBe(1);
  expect((await getRun(interrupted.id)).checkpoint.cursor).toBe("2");
});

it("finishing an attempt immediately queues the next store through its own queue", async () => {
  const { downloadJob: runJob } =
    await import("@/nextsignal/processes/distributed/jobs");
  const { services } = await import("@/nextsignal/services");
  const { config } = await import("@/nextsignal/config");
  const { loggerAdapter } = await import("@/nextsignal/adapters/logger");
  const { ok } = await import("@gotch/nextsignal");
  const owner = await start({ kind: "discover", retailers: ["kam", "spar"] });
  await executeTask(owner.id);
  const first = (await claimPendingRuns(1))[0];
  const dispatch = vi.fn(async (name: string) => {
    if (name === "catalog.execute")
      await pool.query(
        `UPDATE runs SET status='success',attempts=1 WHERE id=$1`,
        [first.id],
      );
    return ok();
  });
  const ctx = {
    services,
    config,
    logger: loggerAdapter,
    mediator: { dispatch },
    metadata: {
      processName: `catalog.${first.retailer}.job`,
      correlationId: randomUUID(),
    },
  } as unknown as Parameters<typeof runJob.work>[0];
  await runJob.work(ctx, {
    run_id: first.id,
    dispatch_token: first.dispatch_token,
  });
  const other = first.retailer === "kam" ? "spar" : "kam";
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(dispatch).toHaveBeenLastCalledWith("catalog.download", {
    run_id: expect.any(String),
    dispatch_token: expect.any(String),
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("waiting for a source cooldown refunds the attempt and preserves its next retry time", async () => {
  const { services } = await import("@/nextsignal/services");
  const { SourceDeferred } = await import("@/nextsignal/domain/types");
  const owner = await start({ kind: "discover" });
  await executeTask(owner.id);
  const run = (await pendingRuns(50))[0];
  const until = new Date(Date.now() + 300000).toISOString();
  vi.spyOn(services.importers, "discover").mockRejectedValue(
    new SourceDeferred(new URL(settings.sources.kam.url).host, until),
  );
  await authorizeRun(run.id, () =>
    app.dispatch("catalog.execute", { run_id: run.id }),
  );
  expect(await getRun(run.id)).toMatchObject({
    status: "pending",
    attempts: 0,
  });
  expect(
    (
      await pool.query<{ next_attempt_at: Date }>(
        `SELECT next_attempt_at FROM runs WHERE id=$1`,
        [run.id],
      )
    ).rows[0].next_attempt_at.toISOString(),
  ).toBe(until);
  expect(await claimPendingRuns(50)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([1, settings.queue.retry_limit + 1])(
  "keeps an interrupted attempt recoverable without exceeding its %i attempt count",
  async (attempts) => {
    const owner = await start({ kind: "discover" });
    await executeTask(owner.id);
    const claim = (await claimPendingRuns(1))[0];
    await expect(
      authorizeRun(
        claim.id,
        async () => {
          await pool.query(
            `UPDATE runs SET status='running',attempts=$2,retry_failures=$2-1 WHERE id=$1`,
            [claim.id, attempts],
          );
          throw new Error("Unexpected interruption");
        },
        claim.dispatch_token,
      ),
    ).rejects.toThrow("Unexpected interruption");
    expect(await getRun(claim.id)).toMatchObject({
      status: attempts > settings.queue.retry_limit ? "failed" : "pending",
      attempts,
    });
    expect(
      (
        await pool.query(`SELECT dispatch_token FROM runs WHERE id=$1`, [
          claim.id,
        ])
      ).rows[0].dispatch_token,
    ).toBeNull();
    expect(await claimPendingRuns(50)).toEqual([]);
  },
);

it("uncertain publication cannot revoke capacity already owned by a running worker", async () => {
  const { dispatchPending } =
    await import("@/nextsignal/processes/distributed/jobs");
  const { services } = await import("@/nextsignal/services");
  const { config } = await import("@/nextsignal/config");
  const { loggerAdapter } = await import("@/nextsignal/adapters/logger");
  const { ok } = await import("@gotch/nextsignal");
  const owner = await start({ kind: "discover" });
  await executeTask(owner.id);
  let entered!: () => void,
    finish!: () => void,
    delivery: Promise<unknown> | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const dispatch = vi.fn(
    async (
      _name: string,
      input: { run_id: string; dispatch_token: string },
    ) => {
      delivery = authorizeRun(
        input.run_id,
        async () => {
          await pool.query(
            `UPDATE runs SET status='running',attempts=1 WHERE id=$1`,
            [input.run_id],
          );
          entered();
          await gate;
          await pool.query(`UPDATE runs SET status='success' WHERE id=$1`, [
            input.run_id,
          ]);
          return ok();
        },
        input.dispatch_token,
      );
      await started;
      throw new Error("Broker accepted work but its acknowledgement was lost");
    },
  );
  const ctx = {
    services,
    config,
    logger: loggerAdapter,
    mediator: { dispatch },
    metadata: { processName: "catalog.tick", correlationId: randomUUID() },
  } as unknown as Parameters<typeof dispatchPending>[0];
  try {
    await expect(dispatchPending(ctx)).rejects.toThrow(
      "acknowledgement was lost",
    );
    const run = (
      await pool.query(
        `SELECT status,dispatch_token FROM runs WHERE task_id=$1`,
        [owner.id],
      )
    ).rows[0];
    expect(run.status).toBe("running");
    expect(run.dispatch_token).not.toBeNull();
    expect(await claimPendingRuns(50)).toEqual([]);
  } finally {
    finish();
    await delivery;
  }
});

it.each(["running", "paused", "global pause"] as const)(
  "a surviving worker recovers a crashed %s owner without a restart",
  async (ownerState) => {
    const owner = await start({ kind: "discover" });
    await executeTask(owner.id);
    const first = (await claimPendingRuns(1))[0];
    await pool.query(
      `UPDATE runs SET status='running',attempts=1,checkpoint='{"cursor":"2"}',dispatch_until=now()-interval '1 second' WHERE id=$1`,
      [first.id],
    );
    if (ownerState === "paused")
      await pool.query(
        `UPDATE task_executions SET state='paused' WHERE id=$1`,
        [owner.id],
      );
    if (ownerState === "global pause") await policy({ paused: true });
    const next = await claimPendingRuns(1);
    if (ownerState === "running") {
      expect(next).toHaveLength(1);
      expect(next[0].id).toBe(first.id);
      expect(next[0].dispatch_token).not.toBe(first.dispatch_token);
      expect(await getRun(first.id)).toMatchObject({
        status: "queued",
        attempts: 1,
        checkpoint: { cursor: "2" },
      });
    } else {
      expect(next).toEqual([]);
      expect(await getRun(first.id)).toMatchObject({
        status: "paused",
        attempts: 1,
        checkpoint: { cursor: "2" },
      });
      expect(
        (
          await pool.query(`SELECT dispatch_token FROM runs WHERE id=$1`, [
            first.id,
          ])
        ).rows[0].dispatch_token,
      ).toBeNull();
      if (ownerState === "global pause") await policy({ paused: false });
      const other = await start({ kind: "discover", retailers: ["spar"] });
      await executeTask(other.id);
      expect((await claimPendingRuns(1))[0].retailer).toBe("spar");
    }
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("a crashed worker's final attempt is terminal rather than automatically granting a seventh attempt", async () => {
  const owner = await start({ kind: "discover" });
  await executeTask(owner.id);
  const claim = (await claimPendingRuns(1))[0];
  await pool.query(
    `UPDATE runs SET status='running',attempts=$2,retry_failures=$2-1,dispatch_until=now()-interval '1 second' WHERE id=$1`,
    [claim.id, settings.queue.retry_limit + 1],
  );
  expect(await claimPendingRuns(50)).toEqual([]);
  expect(await getRun(claim.id)).toMatchObject({
    status: "failed",
    attempts: settings.queue.retry_limit + 1,
  });
});

it("sets an uncertain product aside, continues the reviewed scope and exposes recovery separately from category review", async () => {
  await policy({ ai_enabled: true, batch_size: 2 });
  await publish("kam", [
    "Drink alpha 330ml",
    "Drink beta 330ml",
    "Drink gamma 330ml",
    "Untouched drink 330ml",
  ]);
  provider();
  const respond = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementationOnce(
    async () => new Response("private provider error", { status: 503 }),
  );
  const run = await start({
    kind: "categorize",
    use_ai: true,
    product_limit: 3,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  await executeTask(run.id);
  await executeTask(run.id);
  expect(await task(run.id)).toMatchObject({
    state: "completed",
    selected: 3,
    processed: 3,
    unresolved: 1,
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  const deferred = (
    await pool.query(
      "SELECT * FROM task_items WHERE task_id=$1 AND state='deferred'",
      [run.id],
    )
  ).rows[0];
  const receipt = (
    await pool.query("SELECT * FROM ai_usage WHERE id=$1", [
      deferred.deferred_usage_id,
    ])
  ).rows[0];
  expect(receipt).toMatchObject({ status: "uncertain", http_status: 503 });
  expect(Number(receipt.cost_usd)).toBeGreaterThan(0);
  expect(
    (
      await pool.query(
        "SELECT category_pending FROM store_products WHERE id=$1",
        [deferred.store_product_id],
      )
    ).rows[0].category_pending,
  ).toBe(true);
  const results = await taskResults({
    id: run.id,
    page: 1,
    size: 10,
    search: "",
    category: "",
    outcome: "deferred",
  });
  expect(results?.summary).toMatchObject({
    total: 3,
    assigned: 2,
    needs_review: 0,
    deferred: 1,
    waiting: 0,
  });
  expect(results?.rows).toHaveLength(1);
  expect(results?.rows[0]).toMatchObject({
    outcome: "deferred",
    assigned_category: null,
  });
  expect(results?.rows[0].reason).toContain("503");
  expect(
    JSON.stringify(
      (
        await pool.query(
          "SELECT message,data,error FROM logs WHERE data->>'task_id'=$1",
          [run.id],
        )
      ).rows,
    ),
  ).not.toContain("private provider error");

  // Explicit recovery does not silently pay again for the uncertain request,
  // does not select the fourth product and does not reset the original caps.
  const saved = await readSettings();
  await controlTask(run.id, "retry_deferred", saved.revision, "tester");
  await executeTask(run.id);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await task(run.id)).toMatchObject({
    state: "completed",
    selected: 3,
    processed: 3,
    unresolved: 1,
  });
  expect((await task(run.id)).options).toEqual(run.options);
  expect(
    (
      await pool.query("SELECT status,cost_usd FROM ai_usage WHERE id=$1", [
        receipt.id,
      ])
    ).rows[0],
  ).toMatchObject({ status: "uncertain", cost_usd: receipt.cost_usd });
  vi.mocked(fetch).mockImplementation(respond);
});

it("resumes a task left by the old worker without repeating its uncertain call or losing saved results", async () => {
  const saved = await policy({ ai_enabled: true, batch_size: 2 });
  await publish("kam", [
    "First drink 330ml",
    "Second drink 330ml",
    "Third drink 330ml",
  ]);
  provider();
  vi.mocked(fetch).mockImplementationOnce(
    async () => new Response("", { status: 503 }),
  );
  const run = await start({
    kind: "categorize",
    use_ai: true,
    product_limit: 3,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  // Recreate the previous release's paused checkpoint: one completed result
  // and the failed request still at the front of the pending items.
  await pool.query(
    "UPDATE task_items SET state='pending',result=NULL,finished_at=NULL WHERE task_id=$1 AND state='deferred'",
    [run.id],
  );
  await pool.query(
    "UPDATE task_executions SET state='paused',processed=1,unresolved=0,reason='Identical request is in progress or needs billing reconciliation' WHERE id=$1",
    [run.id],
  );
  await controlTask(run.id, "resume", saved.revision, "tester");
  await executeTask(run.id);
  await executeTask(run.id);
  await executeTask(run.id);
  expect(fetch).toHaveBeenCalledTimes(3); // First failed call + two successes.
  expect(await task(run.id)).toMatchObject({
    state: "completed",
    processed: 3,
    selected: 3,
    unresolved: 1,
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM store_product_classifications",
      )
    ).rows[0].n,
  ).toBe(2);
});

it("pauses after consecutive provider failures across batches and resumes only unfinished products", async () => {
  settings.matching.gateway.consecutive_failure_limit = 2;
  const saved = await policy({ ai_enabled: true, batch_size: 1 });
  await publish("kam", [
    "Drink one 330ml",
    "Drink two 330ml",
    "Drink three 330ml",
  ]);
  vi.mocked(fetch).mockImplementation(
    async () => new Response("", { status: 503 }),
  );
  const run = await start({
    kind: "categorize",
    use_ai: true,
    product_limit: 3,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  expect((await task(run.id)).state).toBe("queued");
  await executeTask(run.id);
  expect(await task(run.id)).toMatchObject({
    state: "paused",
    processed: 2,
    unresolved: 2,
  });
  await executeTask(run.id);
  expect(fetch).toHaveBeenCalledTimes(2);
  provider();
  await pool.query(
    "UPDATE gateway_cooldown SET retry_at=now()-interval '1 second'",
  );
  await controlTask(run.id, "resume", saved.revision, "tester");
  await executeTask(run.id);
  expect(await task(run.id)).toMatchObject({
    state: "completed",
    processed: 3,
    selected: 3,
    unresolved: 2,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM ai_usage WHERE status='uncertain'",
      )
    ).rows[0].n,
  ).toBe(2);
});

it("keeps global access and spending failures paused rather than skipping the entire catalog", async () => {
  await policy({ ai_enabled: true });
  await publish("kam", ["Drink one 330ml", "Drink two 330ml"]);
  vi.mocked(fetch).mockResolvedValue(new Response("", { status: 401 }));
  const run = await start({
    kind: "categorize",
    use_ai: true,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  expect(await task(run.id)).toMatchObject({
    state: "paused",
    processed: 0,
    unresolved: 0,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    (
      await pool.query("SELECT state FROM task_items WHERE task_id=$1", [
        run.id,
      ])
    ).rows.every((r) => r.state === "pending"),
  ).toBe(true);
});

it("recovers a deferred product from a reconciled saved response without paying again or selecting more products", async () => {
  const saved = await policy({ ai_enabled: true, batch_size: 1 });
  await publish("kam", ["Drink alpha 330ml", "Drink beta 330ml"]);
  provider();
  const respond = vi.mocked(fetch).getMockImplementation()!;
  const recoveredResponse = await (
    await respond("https://test.invalid", {
      method: "POST",
      body: JSON.stringify({ questions: { family: {} } }),
    })
  ).json();
  vi.mocked(fetch).mockImplementationOnce(
    async () => new Response("", { status: 503 }),
  );
  const run = await start({
    kind: "categorize",
    use_ai: true,
    product_limit: 1,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  const usage = (
    await pool.query("SELECT * FROM ai_usage WHERE task_id=$1", [run.id])
  ).rows[0];
  // Simulate receipt recovery: no provider call, no inferred zero charge.
  await pool.query(
    "UPDATE ai_usage SET status='success',cost_usd='0.000002',input_tokens=100,generation_id='gen_recovered' WHERE id=$1",
    [usage.id],
  );
  await pool.query("INSERT INTO ai_cache(key,result) VALUES($1,$2)", [
    usage.request_key,
    JSON.stringify({
      ...recoveredResponse,
      __cached: false,
      __accounting: {
        input_tokens: 100,
        output_tokens: 0,
        cost_usd: "0.000002",
        generation_id: "gen_recovered",
      },
    }),
  ]);
  await controlTask(run.id, "retry_deferred", saved.revision, "tester");
  await executeTask(run.id);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await task(run.id)).toMatchObject({
    state: "completed",
    processed: 1,
    selected: 1,
    unresolved: 0,
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM ai_usage WHERE task_id=$1",
        [run.id],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM store_products WHERE category_pending",
      )
    ).rows[0].n,
  ).toBe(1);
});

it("does not automatically sweep a deferred categorization again and preserves code-only matching permission", async () => {
  const saved = await policy({
    ai_enabled: true,
    categorization: "automatic",
    matching: "automatic",
  });
  await publish("kam", ["An uncertain drink 330ml"]);
  await pool.query(
    "UPDATE matching_work SET auto_category_epoch=$1,auto_match_epoch=$2,auto_ai_epoch=$3",
    [saved.epochs.categorization, saved.epochs.matching, saved.epochs.ai],
  );
  vi.mocked(fetch).mockImplementation(
    async () => new Response("", { status: 503 }),
  );
  const run = await start({
    kind: "categorize",
    use_ai: true,
    product_limit: 1,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  expect(
    (
      await pool.query(
        "SELECT auto_category_epoch,auto_match_epoch FROM matching_work",
      )
    ).rows[0],
  ).toEqual({
    auto_category_epoch: null,
    auto_match_epoch: saved.epochs.matching,
  });
  await automaticTasks();
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM task_executions WHERE origin='automatic' AND kind='categorize'",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("enforces the reviewed request cap between safe retries and never retries deferred work with AI disabled", async () => {
  const saved = await policy({ ai_enabled: true, task_request_limit: 1 });
  settings.matching.gateway.retry_delay_ms = 1;
  settings.matching.gateway.retry_max_delay_ms = 1;
  await publish("kam", ["Limited drink 330ml"]);
  vi.mocked(fetch).mockImplementation(
    async () => new Response("", { status: 429 }),
  );
  const run = await start({
    kind: "categorize",
    use_ai: true,
    product_limit: 1,
    max_cost_usd: 0.1,
  });
  await executeTask(run.id);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await task(run.id)).toMatchObject({ state: "paused", processed: 0 });
  expect((await task(run.id)).reason).toContain("request limit");
  await controlTask(run.id, "resume", saved.revision, "tester");
  await executeTask(run.id);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM ai_usage WHERE task_id=$1",
        [run.id],
      )
    ).rows[0].n,
  ).toBe(1);

  await pool.query("UPDATE task_items SET state='deferred' WHERE task_id=$1", [
    run.id,
  ]);
  await pool.query(
    "UPDATE task_executions SET state='completed',processed=1,unresolved=1 WHERE id=$1",
    [run.id],
  );
  const off = await policy({ ai_enabled: false });
  await expect(
    controlTask(run.id, "retry_deferred", off.revision, "tester"),
  ).rejects.toThrow("AI permission");
  expect((await task(run.id)).state).toBe("completed");
  expect(
    (
      await pool.query("SELECT state FROM task_items WHERE task_id=$1", [
        run.id,
      ])
    ).rows[0].state,
  ).toBe("deferred");
});
