import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool, transaction } from "@/nextsignal/services/database";
import {
  readImportProgress,
  readImportRetryCandidates,
} from "@/nextsignal/services/import-progress";
import { seedRetailers } from "@/nextsignal/services/catalog-repository";
import { executeTask } from "@/nextsignal/services/tasks";
import type { Retailer } from "@/nextsignal/domain/types";

beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  await pool.query(
    "TRUNCATE retailers,products,runs,sources,listings,operational_settings,operational_settings_history,task_executions CASCADE",
  );
  await seedRetailers();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected external activity");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => pool.end());

async function task() {
  const options = {
    kind: "import",
    retailers: ["kam", "stokomak", "zito"],
    source_id: null,
    product_limit: null,
    use_ai: false,
    categories: [],
    max_cost_usd: 0,
    recheck: false,
    revision: 1,
    idempotency_key: randomUUID(),
  };
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO task_executions(kind,origin,manual_authorized,settings_revision,policy,epochs,options,idempotency_key,created_by,reason,checkpoint,state)
       VALUES('import','manual',true,1,$1,'{"imports":0,"categorization":0,"matching":0,"ai":0}',$2,$3,'tester','Test fixture','{"initialized":true}','running') RETURNING id`,
      [settings.tasks.defaults, options, options.idempotency_key],
    )
  ).rows[0].id;
}

async function run(
  taskId: string,
  status: string,
  options: {
    retailer?: Retailer;
    kind?: "catalog" | "discover";
    error?: string;
    checkpoint?: Record<string, unknown>;
    summary?: Record<string, unknown>;
    finishedAt?: string;
    sourceId?: string;
  } = {},
) {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO runs(task_id,kind,retailer,status,error,checkpoint,summary,finished_at,source_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        taskId,
        options.kind ?? "catalog",
        options.retailer ?? "kam",
        status,
        options.error ?? null,
        options.checkpoint ?? {},
        options.summary ?? {},
        options.finishedAt ?? "2026-10-25T09:00:00Z",
        options.sourceId ?? null,
      ],
    )
  ).rows[0].id;
}

it("reports the real failed store instead of a more recent resolved quarantine", async () => {
  const id = await task();
  const failed = await run(id, "failed", {
    retailer: "stokomak",
    kind: "discover",
    error: "Price website unavailable",
  });
  const quarantine = await run(id, "quarantined", {
    finishedAt: "2026-10-25T10:00:00Z",
  });
  await run(id, "success", { checkpoint: { confirmation_of: quarantine } });
  const progress = await readImportProgress(id);
  expect(progress).toMatchObject({
    failed: 1,
    done: 1,
    failure: {
      id: failed,
      retailer: "stokomak",
      error: "Price website unavailable",
    },
  });
  await executeTask(id);
  const saved = (
    await pool.query("SELECT state,reason FROM task_executions WHERE id=$1", [
      id,
    ])
  ).rows[0];
  expect(saved).toMatchObject({
    state: "failed",
    reason: "Stokomak: Price website unavailable",
  });
  expect(
    (await pool.query("SELECT status FROM runs WHERE id=$1", [quarantine]))
      .rows[0].status,
  ).toBe("quarantined");
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["pending", "queued", "running", "paused", "success"])(
  "does not report a quarantine as failed while its confirmation is %s",
  async (status) => {
    const id = await task();
    const quarantine = await run(id, "quarantined");
    await run(id, status, { checkpoint: { confirmation_of: quarantine } });
    expect(await readImportProgress(id)).toMatchObject({
      failed: 0,
      failure: null,
    });
  },
);

it("follows a confirmation's explicit source-change replacement to its successful outcome", async () => {
  const id = await task();
  const quarantine = await run(id, "quarantined");
  const replacement = await run(id, "success");
  await run(id, "superseded", {
    checkpoint: { confirmation_of: quarantine },
    summary: { replacement_run_id: replacement },
  });
  expect(await readImportProgress(id)).toMatchObject({
    failed: 0,
    done: 1,
    failure: null,
  });
  await executeTask(id);
  expect(
    (await pool.query("SELECT state FROM task_executions WHERE id=$1", [id]))
      .rows[0].state,
  ).toBe("completed");
});

it("keeps a quarantine unresolved when its replacement has failed", async () => {
  const id = await task();
  const quarantine = await run(id, "quarantined");
  const failed = await run(id, "failed", {
    error: "Confirmation could not finish",
    finishedAt: "2026-10-25T11:00:00Z",
  });
  await run(id, "superseded", {
    checkpoint: { confirmation_of: quarantine },
    summary: { replacement_run_id: failed },
  });
  expect(await readImportProgress(id)).toMatchObject({
    failed: 2,
    failure: { id: failed },
  });
});

it("does not resolve a quarantine from an unrelated task's confirmation", async () => {
  const id = await task();
  const quarantine = await run(id, "quarantined");
  await run(await task(), "success", {
    checkpoint: { confirmation_of: quarantine },
  });
  expect(await readImportProgress(id)).toMatchObject({
    failed: 1,
    failure: { id: quarantine },
  });
});

it("safely leaves cyclic replacement history unresolved", async () => {
  const id = await task();
  const quarantine = await run(id, "quarantined");
  const followup = await run(id, "superseded", {
    checkpoint: { confirmation_of: quarantine },
    summary: { replacement_run_id: quarantine },
  });
  await pool.query("UPDATE runs SET summary=$2 WHERE id=$1", [
    quarantine,
    { replacement_run_id: followup },
  ]);
  expect(await readImportProgress(id)).toMatchObject({
    failed: 1,
    failure: { id: quarantine },
  });
});

it("selects only the failed confirmation leaf and retains its resumable checkpoint", async () => {
  const id = await task();
  const quarantine = await run(id, "quarantined");
  const checkpoint = {
    confirmation_of: quarantine,
    cursor: "7",
    pages_saved: 6,
  };
  const confirmation = await run(id, "failed", { checkpoint });
  const candidates = await transaction((client) =>
    readImportRetryCandidates(client, id),
  );
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    id: confirmation,
    checkpoint,
    fresh_snapshot: false,
  });
});

it("selects only a rejected confirmation leaf and requires a fresh snapshot for it", async () => {
  const id = await task();
  const quarantine = await run(id, "quarantined");
  const confirmation = await run(id, "quarantined", {
    checkpoint: { confirmation_of: quarantine, done: true },
  });
  const candidates = await transaction((client) =>
    readImportRetryCandidates(client, id),
  );
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    id: confirmation,
    fresh_snapshot: true,
  });
});

it("does not retry quarantines whose confirmations are active or completed", async () => {
  const id = await task();
  const active = await run(id, "quarantined");
  const complete = await run(id, "quarantined");
  await run(id, "pending", { checkpoint: { confirmation_of: active } });
  await run(id, "success", { checkpoint: { confirmation_of: complete } });
  expect(
    await transaction((client) => readImportRetryCandidates(client, id)),
  ).toEqual([]);
});

it("reports failed discoveries separately from catalogs and lists their actual stores", async () => {
  const id = await task();
  await run(id, "failed", { retailer: "stokomak", kind: "discover" });
  await run(id, "failed", { retailer: "zito", kind: "discover" });
  const quarantine = await run(id, "quarantined");
  await run(id, "success", { checkpoint: { confirmation_of: quarantine } });
  expect(await readImportProgress(id)).toMatchObject({
    failed_catalogs: 0,
    failed_discoveries: 2,
    failure_stores: ["stokomak", "zito"],
  });
});

it("counts a failed confirmation chain as one affected catalog", async () => {
  const id = await task();
  const source = (
    await pool.query(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES('kam','test','Test',$1,'branch','{}') RETURNING id",
      [settings.sources.kam.url],
    )
  ).rows[0].id;
  const quarantine = await run(id, "quarantined", { sourceId: source });
  await run(id, "failed", {
    sourceId: source,
    checkpoint: { confirmation_of: quarantine },
  });
  expect(await readImportProgress(id)).toMatchObject({
    failed: 2,
    failed_catalogs: 1,
    failed_discoveries: 0,
    failure_stores: ["kam"],
  });
});
