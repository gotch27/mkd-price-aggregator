import { randomUUID } from "node:crypto";
import { beforeEach, afterAll, expect, it, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool, withLock } from "@/nextsignal/services/database";
import { seedRetailers } from "@/nextsignal/services/catalog-repository";
import {
  createTask,
  controlTask,
  listTasks,
} from "@/nextsignal/services/tasks";
import { readSettings } from "@/nextsignal/services/task-settings";
import type { TaskCommand } from "@/nextsignal/domain/task-settings";

beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  await pool.query(
    "TRUNCATE retailers,sources,runs,products,listings,operational_settings,operational_settings_history,task_executions CASCADE",
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
  vi.unstubAllGlobals();
  await pool.end();
});
async function command(changes: Partial<TaskCommand> = {}) {
  const saved = await readSettings();
  return {
    kind: "import" as const,
    retailers: ["kam"] as TaskCommand["retailers"],
    source_id: null,
    product_limit: null,
    use_ai: false,
    categories: [],
    max_cost_usd: 0,
    recheck: false,
    idempotency_key: randomUUID(),
    revision: saved.revision,
    ...changes,
  };
}
async function source(retailer = "kam") {
  return (
    await pool.query(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,'Test','https://example.test/catalog','branch','{}') RETURNING id",
      [retailer, randomUUID()],
    )
  ).rows[0].id as string;
}
it("blocks overlapping all-store imports and explains the existing work", async () => {
  const first = await createTask(await command(), "tester");
  await expect(createTask(await command(), "tester")).rejects.toThrow(
    "already queued or running for KAM",
  );
  expect(
    (await pool.query("SELECT count(*)::int n FROM task_executions")).rows[0].n,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT data FROM logs WHERE data->>'event'='tasks.import.overlap.prevented' ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0].data.existing_task_id,
  ).toBe(first.id);
  expect(fetch).not.toHaveBeenCalled();
});
it("serializes concurrent overlapping starts and preserves exact idempotent retries", async () => {
  const a = await command(),
    b = await command();
  const results = await Promise.allSettled([
    createTask(a, "tester"),
    createTask(b, "tester"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const accepted = results.find((r) => r.status === "fulfilled")!;
  if (accepted.status !== "fulfilled") throw new Error("Missing task");
  const replay = await createTask(accepted.value.options, "tester");
  expect(replay.id).toBe(accepted.value.id);
  expect(
    (await pool.query("SELECT count(*)::int n FROM task_executions")).rows[0].n,
  ).toBe(1);
});
it("allows distinct catalogs in the same chain but blocks a broad overlapping import", async () => {
  const one = await source(),
    two = await source();
  await createTask(await command({ source_id: one }), "tester");
  await createTask(await command({ source_id: two }), "tester");
  await expect(createTask(await command(), "tester")).rejects.toThrow(
    "already queued or running",
  );
  await expect(
    createTask(await command({ source_id: one }), "tester"),
  ).rejects.toThrow("already queued or running");
  await createTask(await command({ retailers: ["spar"] }), "tester");
  expect(
    (await pool.query("SELECT count(*)::int n FROM task_executions")).rows[0].n,
  ).toBe(3);
});
it("checks overlap again when a paused task resumes", async () => {
  const old = await createTask(await command(), "tester");
  const revision = (await readSettings()).revision;
  await controlTask(old.id, "pause", revision, "tester");
  await createTask(await command(), "tester");
  await expect(
    controlTask(old.id, "resume", revision, "tester"),
  ).rejects.toThrow("already queued or running");
  expect(
    (
      await pool.query("SELECT state FROM task_executions WHERE id=$1", [
        old.id,
      ])
    ).rows[0].state,
  ).toBe("paused");
});
it("retries only the reviewed failed stores while the active import keeps its completed work", async () => {
  const owner = await createTask(
    await command({ retailers: ["kam", "stokomak", "zito"] }),
    "tester",
  );
  await pool.query(
    "UPDATE task_executions SET state='running',checkpoint='{\"initialized\":true}' WHERE id=$1",
    [owner.id],
  );
  const completed = (
    await pool.query(
      "INSERT INTO runs(task_id,kind,retailer,status) VALUES($1,'discover','kam','success') RETURNING id",
      [owner.id],
    )
  ).rows[0].id;
  const failed = (
    await pool.query(
      "INSERT INTO runs(task_id,kind,retailer,status,error) VALUES($1,'discover','stokomak','failed','Website unavailable'),($1,'discover','zito','failed','Website unavailable') RETURNING id,retailer",
      [owner.id],
    )
  ).rows;
  await controlTask(
    owner.id,
    "retry_failed",
    owner.settings_revision,
    "tester",
    false,
    ["stokomak"],
  );
  const all = (
    await pool.query(
      "SELECT id,retailer,status,checkpoint FROM runs WHERE task_id=$1",
      [owner.id],
    )
  ).rows;
  expect(all.find((r) => r.id === completed).status).toBe("success");
  expect(
    all.find((r) => r.id === failed.find((r) => r.retailer === "zito").id)
      .status,
  ).toBe("failed");
  expect(
    all
      .filter((r) => r.retailer === "stokomak")
      .map((r) => r.status)
      .sort(),
  ).toEqual(["pending", "superseded"]);
  expect(
    (
      await pool.query(
        "SELECT state,policy,options FROM task_executions WHERE id=$1",
        [owner.id],
      )
    ).rows[0],
  ).toMatchObject({
    state: "running",
    policy: owner.policy,
    options: owner.options,
  });
  const page = await listTasks(1, 10);
  expect(page.rows[0]).toMatchObject({
    failed_discoveries: 1,
    failure_stores: ["zito"],
  });
  expect(
    (await pool.query("SELECT count(*)::int n FROM task_executions")).rows[0].n,
  ).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});
it("does not let an active task refresh race a retry request or expand retry scope", async () => {
  const owner = await createTask(await command(), "tester");
  await withLock(`task:${owner.id}`, async () => {
    await expect(
      controlTask(
        owner.id,
        "retry_failed",
        owner.settings_revision,
        "tester",
        false,
        ["kam"],
      ),
    ).rejects.toThrow("updating its progress");
  });
  await expect(
    controlTask(
      owner.id,
      "retry_failed",
      owner.settings_revision,
      "tester",
      false,
      ["spar"],
    ),
  ).rejects.toThrow("original scope");
});
it("restarts a rejected complete confirmation from fresh data rather than copying its rejected staging", async () => {
  const s = await source();
  const owner = await createTask(await command({ source_id: s }), "tester");
  const bad = (
    await pool.query(
      "INSERT INTO runs(task_id,kind,retailer,source_id,status,checkpoint) VALUES($1,'catalog','kam',$2,'quarantined',$3) RETURNING id",
      [
        owner.id,
        s,
        {
          source_url: "https://example.test/catalog",
          done: true,
          cursor: "26",
          confirmation_of: randomUUID(),
          snapshot_started_at: "2026-01-01T00:00:00Z",
        },
      ],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO staging(run_id,key,data) VALUES($1,'old','{}')",
    [bad],
  );
  await controlTask(
    owner.id,
    "retry_failed",
    owner.settings_revision,
    "tester",
    false,
    ["kam"],
  );
  const replacement = (
    await pool.query(
      "SELECT id,checkpoint FROM runs WHERE task_id=$1 AND status='pending'",
      [owner.id],
    )
  ).rows[0];
  expect(replacement.checkpoint).toEqual({
    source_url: "https://example.test/catalog",
    retry_of: bad,
  });
  expect(
    (
      await pool.query("SELECT count(*)::int n FROM staging WHERE run_id=$1", [
        replacement.id,
      ])
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await pool.query("SELECT count(*)::int n FROM staging WHERE run_id=$1", [
        bad,
      ])
    ).rows[0].n,
  ).toBe(1);
});
