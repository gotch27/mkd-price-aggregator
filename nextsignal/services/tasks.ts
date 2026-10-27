import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { settings } from "@/nextsignal/config";
import {
  taskCommandSchema,
  TaskConflict,
  TaskPaused,
  GatewayCoolingDown,
  operationFor,
  type TaskCommand,
  type TaskExecution,
  type SavedTaskSettings,
} from "@/nextsignal/domain/task-settings";
import { hash } from "@/nextsignal/domain/normalize";
import { pool, transaction, withLock } from "./database";
import { readSettings, nextOccurrences } from "./task-settings";
import { withTaskContext, assertPermission, checkpoint } from "./task-context";
import { logEvent } from "@/nextsignal/adapters/log-context";
import { productTask } from "./task-products";
import { availableProductSql } from "./product-availability";
import { GatewayDeferred } from "./ai-gateway";
import { coolTask, wakeCoolingTasks } from "./task-cooldown";
import { notHeldProductSql } from "./task-product-eligibility";
import {
  claimPendingRuns,
  releaseDispatch,
  importCapacityAllowed,
  type ImportPhase,
} from "./import-dispatch";
import { blockedRetailers } from "./source-health";
import { assertImportScopeAvailable } from "./import-task-guards";
import {
  readImportProgress,
  readImportRetryCandidates,
} from "./import-progress";

export async function createTask(
  input: TaskCommand,
  actor: string,
  origin: TaskExecution["origin"] = "manual",
) {
  const options = taskCommandSchema.parse(input),
    saved = await readSettings();
  return transaction((c) => insertTask(c, options, actor, saved, origin));
}
async function insertTask(
  c: PoolClient,
  options: TaskCommand,
  actor: string,
  saved: SavedTaskSettings,
  origin: TaskExecution["origin"],
) {
  // Serialize settings review with saves/schedule publication. No external work here.
  const current = (
    await c.query(
      `SELECT revision FROM operational_settings WHERE id FOR SHARE`,
    )
  ).rows[0];
  if (
    options.revision !== current.revision ||
    saved.revision !== current.revision
  )
    throw new TaskConflict(
      "Settings changed. Reload and review the task again.",
    );
  if (saved.policy.paused || saved.policy[operationFor(options.kind)] === "off")
    throw new TaskConflict("This operation is paused or off.");
  if (
    options.use_ai &&
    (!saved.policy.ai_enabled ||
      settings.matching.gateway.api_key === "disabled")
  )
    throw new TaskConflict(
      "Enable AI permission and configure the Gateway key first.",
    );
  if (options.max_cost_usd > saved.policy.task_budget_usd)
    throw new TaskConflict(
      "The task allowance exceeds the saved per-task spending limit.",
    );
  if (options.retailers.some((r) => !settings.sources[r].enabled))
    throw new TaskConflict(
      "The selected store is disabled in deployment configuration.",
    );
  if (
    options.source_id &&
    !(
      await c.query(
        `SELECT 1 FROM sources WHERE id=$1 AND retailer=ANY($2::text[]) AND active`,
        [options.source_id, options.retailers],
      )
    ).rowCount
  )
    throw new TaskConflict("The catalog is not active in the selected stores.");
  await assertImportScopeAvailable(c, options);
  const result = (
    await c.query<TaskExecution>(
      `INSERT INTO task_executions(kind,origin,manual_authorized,settings_revision,policy,epochs,options,idempotency_key,created_by,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'Waiting for a worker') ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
      [
        options.kind,
        origin,
        origin === "manual",
        saved.revision,
        saved.policy,
        saved.epochs,
        options,
        options.idempotency_key,
        actor,
      ],
    )
  ).rows[0];
  if (!result) {
    const existing = (
      await c.query<TaskExecution>(
        `SELECT * FROM task_executions WHERE idempotency_key=$1`,
        [options.idempotency_key],
      )
    ).rows[0];
    if (hash(existing.options) !== hash(options))
      throw new TaskConflict(
        "This task request was already used with different options.",
      );
    return existing;
  }
  await logEvent("info", "tasks.authorized", "Task authorized", {
    task_id: result.id,
    actor,
    origin,
    kind: options.kind,
    scope: options.retailers,
    source_id: options.source_id,
    product_limit: options.product_limit,
    use_ai: options.use_ai,
    max_cost_usd: options.max_cost_usd,
    settings_revision: saved.revision,
  });
  return result;
}
export async function listTasks(page: number, size: number) {
  const rows = (
    await pool.query(
      `SELECT t.*,coalesce(u.spent,0)::text AS spent_usd,coalesce(u.requests,0)::int AS requests,coalesce(u.uncertain,0)::int AS uncertain_requests,
      (SELECT count(*)::int FROM task_items WHERE task_id=t.id AND state='deferred') AS deferred,
      (SELECT count(DISTINCT source_id)::int FROM runs WHERE task_id=t.id AND kind='catalog' AND status='success') AS published_catalogs,
      progress.*
      FROM task_executions t LEFT JOIN LATERAL(SELECT sum(cost_usd) AS spent,count(*) AS requests,count(*) FILTER(WHERE status IN ('reserved','uncertain')) AS uncertain FROM ai_usage WHERE task_id=t.id) u ON true
      LEFT JOIN LATERAL (
        SELECT count(DISTINCT source_id)::int AS total_catalogs,
          count(DISTINCT source_id) FILTER(WHERE attempts=0 AND status IN ('pending','queued','paused'))::int AS unstarted_catalogs,
          count(DISTINCT source_id) FILTER(WHERE status='failed')::int AS failed_catalogs,
          coalesce(sum(coalesce((checkpoint->>'pages_saved')::int,0)) FILTER(WHERE status IN ('pending','queued','running','paused')),0)::int AS saved_pages,
          max(last_progress_at) AS last_progress_at
          ,count(*) FILTER(WHERE status='running' AND dispatch_phase='download')::int AS downloading_catalogs
          ,count(*) FILTER(WHERE status='running' AND dispatch_phase='publish')::int AS publishing_catalogs
          ,count(*) FILTER(WHERE status IN ('pending','queued') AND checkpoint->>'done'='true')::int AS ready_catalogs
        FROM runs WHERE task_id=t.id AND kind='catalog' AND status<>'superseded'
      ) progress ON true ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`,
      [size, (page - 1) * size],
    )
  ).rows;
  const truthfulRows = await Promise.all(
    rows.map(async (row) => {
      if (!["import", "discover"].includes(row.kind)) return row;
      if (row.state === "completed")
        return {
          ...row,
          failed_catalogs: 0,
          failed_discoveries: 0,
          failure_stores: [],
        };
      const progress = await readImportProgress(row.id);
      return {
        ...row,
        failed_catalogs: progress.failed_catalogs,
        failed_discoveries: progress.failed_discoveries,
        failure_stores: progress.failure_stores,
        ...(row.state === "failed" && progress.failure
          ? { reason: importFailureReason(progress.failure) }
          : {}),
      };
    }),
  );
  return {
    rows: truthfulRows,
    total: (
      await pool.query(`SELECT count(*)::int AS total FROM task_executions`)
    ).rows[0].total,
    page,
    size,
  };
}
export async function controlTask(
  id: string,
  action: "pause" | "resume" | "retry_failed" | "retry_deferred",
  revision: number,
  actor: string,
  adoptImportLimits?: boolean,
  retryStores?: string[],
) {
  if (action !== "retry_failed" && action !== "retry_deferred")
    return controlTaskLocked(
      id,
      action,
      revision,
      actor,
      adoptImportLimits,
      retryStores,
    );
  const result = await withLock(`task:${id}`, () =>
    controlTaskLocked(
      id,
      action,
      revision,
      actor,
      adoptImportLimits,
      retryStores,
    ),
  );
  if (!result)
    throw new TaskConflict(
      "This task is updating its progress. Try the retry action again shortly.",
    );
  return result;
}
async function controlTaskLocked(
  id: string,
  action: "pause" | "resume" | "retry_failed" | "retry_deferred",
  revision: number,
  actor: string,
  adoptImportLimits?: boolean,
  retryStores?: string[],
) {
  const saved = await readSettings();
  let retriedRuns: string[] = [];
  let limitChange: { before: unknown; after: unknown } | undefined;
  if (saved.revision !== revision)
    throw new TaskConflict("Settings changed. Reload before continuing.");
  await transaction(async (c) => {
    const current = (
      await c.query(
        `SELECT revision FROM operational_settings WHERE id FOR SHARE`,
      )
    ).rows[0];
    if (current.revision !== revision)
      throw new TaskConflict("Settings changed. Reload before continuing.");
    const task = (
      await c.query<TaskExecution>(
        `SELECT * FROM task_executions WHERE id=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!task) throw new TaskConflict("Task not found");
    if (action === "retry_deferred") {
      if (
        !["categorize", "match"].includes(task.kind) ||
        task.state !== "completed"
      )
        throw new TaskConflict(
          "Retry deferred is available after a product task finishes. Resume a paused task to continue its unfinished work first.",
        );
      if (adoptImportLimits)
        throw new TaskConflict(
          "Import limits do not apply to product recovery.",
        );
      assertPermission(
        { ...task, manual_authorized: true },
        saved,
        task.options.use_ai,
      );
      const deferred = await c.query(
        `UPDATE task_items SET state='pending',result=NULL,finished_at=NULL WHERE task_id=$1 AND state='deferred' RETURNING id`,
        [id],
      );
      if (!deferred.rowCount)
        throw new TaskConflict("This task has no deferred products.");
      // Keep the original selected products, scope, spending and request caps.
      // In particular, an unlimited original task must not sweep more products.
      await c.query(
        `UPDATE task_executions SET state='queued',manual_authorized=true,reason='Retrying only deferred products; saved results are kept',dispatch_until=NULL,updated_at=now(),
          checkpoint=(checkpoint-'provider_failures')||'{"retry_deferred_only":true}'::jsonb,
          processed=(SELECT count(*) FROM task_items WHERE task_id=$1 AND state<>'pending'),
          unresolved=(SELECT count(*) FROM task_items WHERE task_id=$1 AND state='unresolved') WHERE id=$1`,
        [id],
      );
      return;
    }
    if (action === "retry_failed") {
      if (
        !task.manual_authorized ||
        !["import", "discover"].includes(task.kind) ||
        !["queued", "running"].includes(task.state)
      )
        throw new TaskConflict(
          "Retry failed is available on an active reviewed import or discovery task. Resume paused tasks instead.",
        );
      if (adoptImportLimits)
        throw new TaskConflict(
          "Retry failed keeps the task's original download limits.",
        );
      if (
        !retryStores?.length ||
        retryStores.some(
          (store) =>
            !task.options.retailers.includes(
              store as (typeof task.options.retailers)[number],
            ),
        )
      )
        throw new TaskConflict(
          "Review failed stores within this task's original scope.",
        );
      assertPermission(task, saved);
      await assertImportScopeAvailable(c, task.options, task.id);
      retriedRuns = await retryFailedImportRuns(c, task.id, actor, retryStores);
      if (!retriedRuns.length)
        throw new TaskConflict("This task has no failed work to retry.");
      await c.query(
        "UPDATE task_executions SET dispatch_until=NULL,reason='Failed work explicitly queued for retry; completed catalogs are kept',updated_at=now() WHERE id=$1",
        [id],
      );
      return;
    }
    if (adoptImportLimits) {
      if (
        action !== "resume" ||
        !["import", "discover"].includes(task.kind) ||
        !["paused", "failed"].includes(task.state)
      )
        throw new TaskConflict(
          "Review download limits while resuming a paused import task.",
        );
      const before = {
        parallel_imports: task.policy.parallel_imports,
        per_store_downloads: task.policy.per_store_downloads,
      };
      const after = {
        parallel_imports: saved.policy.parallel_imports,
        per_store_downloads: saved.policy.per_store_downloads,
      };
      if (hash(before) !== hash(after)) {
        await c.query(
          "UPDATE task_executions SET policy=policy||$2::jsonb WHERE id=$1",
          [id, after],
        );
        await c.query(
          "INSERT INTO task_import_limit_changes(task_id,actor,settings_revision,before_limits,after_limits) VALUES($1,$2,$3,$4,$5)",
          [id, actor, revision, before, after],
        );
        limitChange = { before, after };
      }
    }
    const canRetryImport =
      action === "resume" && ["import", "discover"].includes(task.kind);
    if (
      task.state === "completed" ||
      (task.state === "failed" && !canRetryImport)
    )
      throw new TaskConflict(
        "This task has finished. Start a new scoped task instead.",
      );
    if (action === "resume" && !["paused", "failed"].includes(task.state))
      throw new TaskConflict(
        "This task is already queued or running. Use Retry failed to retry only its failed work.",
      );
    if (action === "resume") {
      await assertImportScopeAvailable(c, task.options, task.id);
      assertPermission(
        { ...task, manual_authorized: true },
        saved,
        task.options.use_ai,
      );
      if (canRetryImport)
        retriedRuns = await retryFailedImportRuns(c, task.id, actor);
      await c.query(
        `UPDATE task_executions SET state='queued',manual_authorized=true,retry_at=NULL,dispatch_until=NULL,reason='Resumed explicitly',checkpoint=checkpoint-'provider_failures',updated_at=now() WHERE id=$1`,
        [id],
      );
      await c.query(
        `UPDATE runs SET status='pending',dispatch_token=NULL,dispatch_until=NULL,dispatch_phase=NULL
         WHERE task_id=$1 AND status='paused'`,
        [id],
      );
    } else {
      await c.query(
        `UPDATE task_executions SET state='paused',retry_at=NULL,reason='Paused by a person',updated_at=now() WHERE id=$1`,
        [id],
      );
      await c.query(
        `UPDATE runs SET status='paused',dispatch_token=NULL,dispatch_until=NULL,dispatch_phase=NULL
         WHERE task_id=$1 AND status IN ('pending','queued')`,
        [id],
      );
    }
  });
  await logEvent(
    "info",
    `tasks.${action}`,
    action === "pause"
      ? "Task paused"
      : action === "retry_failed"
        ? "Failed work queued for retry; completed catalogs are kept"
        : action === "retry_deferred"
          ? "Deferred products queued for recovery; saved results and original allowances are kept"
          : "Task resumed",
    {
      task_id: id,
      actor,
      settings_revision: revision,
      retried_failed_runs: retriedRuns.length,
      replacement_run_ids: retriedRuns,
      ...(action === "retry_failed"
        ? { reviewed_retry_stores: retryStores }
        : {}),
      ...(limitChange ? { reviewed_import_limits: limitChange } : {}),
    },
  );
  return { id, action };
}

async function retryFailedImportRuns(
  c: PoolClient,
  taskId: string,
  actor: string,
  retryStores?: string[],
) {
  const replacements: string[] = [];
  const failed = await readImportRetryCandidates(c, taskId);
  for (const previous of failed.filter(
    (run) => !retryStores || retryStores.includes(run.retailer),
  )) {
    const obsolete = await c.query(
      `UPDATE runs old SET status='superseded',dispatch_token=NULL,dispatch_until=NULL,dispatch_phase=NULL,
         summary=old.summary||jsonb_build_object('reason',CASE WHEN NOT s.active THEN 'Catalog no longer offered by this supermarket' ELSE 'Newer catalog already published' END)
       FROM sources s LEFT JOIN runs published ON published.id=s.published_run
       WHERE old.id=$1 AND old.source_id=s.id
         AND (NOT s.active OR coalesce((published.checkpoint->>'snapshot_started_at')::timestamptz,published.created_at)
           >coalesce((old.checkpoint->>'snapshot_started_at')::timestamptz,old.created_at))`,
      [previous.id],
    );
    if (obsolete.rowCount) continue;
    const replacement = (
      await c.query<{ id: string }>(
        `INSERT INTO runs(kind,retailer,source_id,parent_id,status,checkpoint,task_id)
         VALUES($1,$2,$3,$4,'pending',$5,$6) RETURNING id`,
        [
          previous.kind,
          previous.retailer,
          previous.source_id,
          previous.parent_id ?? previous.id,
          previous.fresh_snapshot
            ? {
                source_url: previous.checkpoint.source_url,
                retry_of: previous.id,
              }
            : {
                ...previous.checkpoint,
                retry_of: previous.id,
                snapshot_started_at:
                  previous.checkpoint.snapshot_started_at ??
                  previous.created_at.toISOString(),
              },
          taskId,
        ],
      )
    ).rows[0];
    replacements.push(replacement.id);
    if (!previous.fresh_snapshot)
      await c.query(
        `INSERT INTO staging(run_id,key,data) SELECT $2,key,data FROM staging WHERE run_id=$1`,
        [previous.id, replacement.id],
      );
    await c.query(
      `UPDATE runs SET status='superseded',dispatch_token=NULL,dispatch_until=NULL,dispatch_phase=NULL,
         summary=summary||jsonb_build_object('reason','Explicit retry requested',
           'replacement_run_id',$2::text,'retried_by',$3::text)
       WHERE id=$1`,
      [previous.id, replacement.id, actor],
    );
  }
  return replacements;
}
export async function pauseTask(id: string, reason: string) {
  await pool.query(
    `UPDATE task_executions SET state='paused',reason=$2,dispatch_until=NULL,updated_at=now() WHERE id=$1 AND state IN ('running','queued')`,
    [id, reason],
  );
  await logEvent(
    "warn",
    "tasks.checkpoint.paused",
    "Task stopped at a safe checkpoint",
    { task_id: id, reason },
  );
}
export async function executeTask(id: string) {
  return withLock(`task:${id}`, async () => {
    const task = (
      await pool.query<TaskExecution>(
        `SELECT * FROM task_executions WHERE id=$1`,
        [id],
      )
    ).rows[0];
    if (!task || !["queued", "running"].includes(task.state)) return;
    try {
      // Persisted requests must still be supported by the current application.
      // Removed maintenance tasks cannot resume through an old queue delivery.
      if (
        !taskCommandSchema.safeParse(task.options).success ||
        task.kind !== task.options.kind
      )
        throw new TaskConflict(
          "This saved task is no longer supported. Start a new task from Tasks.",
        );
      const live = await readSettings();
      await withTaskContext(task, live, async () => {
        await checkpoint(task.options.use_ai);
        await pool.query(
          `UPDATE task_executions SET state='running',reason='Processing authorized work',updated_at=now() WHERE id=$1`,
          [id],
        );
        await logEvent("info", "tasks.batch.started", "Task batch started", {
          task_id: id,
          kind: task.kind,
          processed: task.processed,
          limit: task.options.product_limit,
        });
        if (task.kind === "import" || task.kind === "discover")
          await importTask(task);
        else await productTask(task);
      });
    } catch (error) {
      if (error instanceof GatewayCoolingDown) {
        if (!(await coolTask(task, error)))
          await pauseTask(
            id,
            "Gateway is temporarily unavailable. Automatic recovery is not currently permitted; resume after the cooldown when permissions allow.",
          );
      } else if (
        error instanceof TaskPaused ||
        error instanceof GatewayDeferred
      )
        await pauseTask(id, error.message);
      else {
        await pool.query(
          `UPDATE task_executions SET state='failed',reason=$2,updated_at=now() WHERE id=$1`,
          [id, error instanceof Error ? error.message : String(error)],
        );
        await logEvent(
          "error",
          "tasks.failed",
          "Task failed; completed work is preserved",
          { task_id: id },
          error,
        );
      }
    } finally {
      await pool.query(
        `UPDATE task_executions SET dispatch_until=NULL WHERE id=$1`,
        [id],
      );
    }
  });
}
async function importTask(task: TaskExecution) {
  await transaction(async (c) => {
    const own = (
      await c.query(
        `SELECT checkpoint FROM task_executions WHERE id=$1 FOR UPDATE`,
        [task.id],
      )
    ).rows[0];
    if (own.checkpoint.initialized) return;
    if (task.options.source_id)
      await c.query(
        `INSERT INTO runs(kind,retailer,source_id,status,task_id,checkpoint) SELECT 'catalog',retailer,id,'pending',$2,jsonb_build_object('source_url',url) FROM sources WHERE id=$1`,
        [task.options.source_id, task.id],
      );
    else
      for (const retailer of task.options.retailers)
        await c.query(
          `INSERT INTO runs(kind,retailer,status,task_id) VALUES('discover',$1,'pending',$2)`,
          [retailer, task.id],
        );
    await c.query(
      `UPDATE task_executions SET checkpoint=jsonb_build_object('initialized',true) WHERE id=$1`,
      [task.id],
    );
  });
  const counts = await readImportProgress(task.id);
  if (!counts.waiting) {
    if (counts.paused)
      throw new TaskPaused("Import paused; resume to continue");
    const failedRun = counts.failure;
    const reason = counts.failed
      ? importFailureReason(failedRun)
      : task.kind === "discover"
        ? "Catalog discovery complete; no prices downloaded"
        : "Complete catalogs published";
    await pool.query(
      `UPDATE task_executions SET state=$2,processed=$3,reason=$4,updated_at=now() WHERE id=$1 AND state IN ('queued','running')`,
      [task.id, counts.failed ? "failed" : "completed", counts.done, reason],
    );
    await logEvent(
      counts.failed ? "warn" : "info",
      "tasks.import.finished",
      task.kind === "discover"
        ? "Catalog discovery task finished"
        : "Price import task finished",
      {
        task_id: task.id,
        kind: task.kind,
        completed_runs: counts.done,
        failed_runs: counts.failed,
        reason,
      },
    );
  } else {
    let reason = counts.running
      ? task.kind === "discover"
        ? "Discovering catalogs; waiting stores will take turns"
        : "Importing prices; waiting stores will take turns"
      : counts.queued
        ? task.kind === "discover"
          ? "Waiting for the worker to start the next store discovery"
          : "Waiting for the worker to start the next catalog"
        : await importWaitReason(task.id);
    if (counts.failed)
      reason +=
        task.kind === "discover"
          ? `; ${counts.failed} store discover${counts.failed === 1 ? "y needs" : "ies need"} an explicit retry`
          : `; ${counts.failed} failed catalog${counts.failed === 1 ? " needs" : "s need"} an explicit retry`;
    await pool.query(
      `UPDATE task_executions SET processed=$2,reason=$3,updated_at=now() WHERE id=$1 AND state IN ('queued','running')`,
      [task.id, counts.done, reason],
    );
  }
}

function importFailureReason(
  failure: {
    retailer: string | null;
    error: string | null;
    status: string;
  } | null,
) {
  const store = failure?.retailer
    ? settings.sources[failure.retailer].name + ": "
    : "";
  return (
    store +
    (failure?.error ??
      (failure?.status === "quarantined"
        ? "The replacement catalog could not be confirmed. Retry this catalog after reviewing Data updates."
        : "A catalog could not be completed. See Data updates for details."))
  );
}

async function importWaitReason(taskId: string) {
  const blocked = new Map(
    (await blockedRetailers()).map((row) => [
      row.retailer,
      Date.parse(row.until),
    ]),
  );
  const pending = (
    await pool.query<{ retailer: string; next_attempt_at: Date | null }>(
      `SELECT retailer,next_attempt_at FROM runs WHERE task_id=$1 AND status='pending'`,
      [taskId],
    )
  ).rows.map((row) => ({
    retailer: row.retailer,
    at: Math.max(
      row.next_attempt_at?.getTime() ?? 0,
      blocked.get(row.retailer) ?? 0,
    ),
  }));
  if (pending.some((row) => row.at <= Date.now()))
    return "Waiting for a free import slot; stores take turns";
  const next = pending.sort((a, b) => a.at - b.at)[0];
  if (!next) return "Waiting for authorized catalog work";
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.app.timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(next.at));
  return `Waiting to retry ${settings.sources[next.retailer].name} after ${time} (${settings.app.timezone}); no import slot is occupied by this wait`;
}
export async function pendingTasks(taskId?: string) {
  await wakeCoolingTasks();
  return reservePendingTasks(taskId, false);
}
export async function pendingProductContinuation(taskId: string) {
  return reservePendingTasks(taskId, true);
}
export async function pendingAutomaticCategoryContinuation(taskId: string) {
  const completed = (
    await pool.query(
      "SELECT 1 FROM task_executions WHERE id=$1 AND kind='categorize' AND origin='automatic' AND state='completed'",
      [taskId],
    )
  ).rowCount;
  if (!completed) return [];
  await automaticTasks();
  const next = (
    await pool.query<{ id: string }>(
      "SELECT id FROM task_executions WHERE kind='categorize' AND origin='automatic' AND state='queued' ORDER BY created_at",
    )
  ).rows;
  const claimed: { id: string }[] = [];
  for (const task of next)
    claimed.push(...(await reservePendingTasks(task.id, true)));
  return claimed;
}
async function reservePendingTasks(
  taskId: string | undefined,
  productContinuation: boolean,
) {
  return (
    await pool.query<{ id: string }>(
      `UPDATE task_executions SET dispatch_until=now()+$1*interval '1 second' WHERE id IN(SELECT id FROM task_executions WHERE ($3::uuid IS NULL OR id=$3) AND state IN ('queued','running')
        AND (NOT $4 OR (id=$3 AND kind IN ('categorize','match') AND state='queued'))
        AND (dispatch_until IS NULL OR dispatch_until<now()) ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING id`,
      [
        settings.queue.dispatch_lease_seconds,
        settings.queue.dispatch_batch,
        taskId ?? null,
        productContinuation,
      ],
    )
  ).rows;
}
export async function releaseTaskDispatch(taskId: string) {
  await pool.query(
    `UPDATE task_executions SET dispatch_until=NULL WHERE id=$1`,
    [taskId],
  );
}
export async function authorizeRun<T>(
  runId: string,
  fn: () => Promise<T>,
  dispatchToken?: string,
  expectedPhase?: ImportPhase,
) {
  // At-least-once deliveries cannot release the lease of an executing copy.
  const result = await withLock(`run-delivery:${runId}`, () =>
    authorizeRunLocked(runId, fn, dispatchToken, expectedPhase),
  );
  // An explicitly invoked CLI operation may finish its selected catalog. It
  // releases the download reservation before requesting a separate save slot.
  if (
    !dispatchToken &&
    result !== null &&
    (
      await pool.query(
        "SELECT 1 FROM runs WHERE id=$1 AND status='pending' AND checkpoint->>'done'='true'",
        [runId],
      )
    ).rowCount
  )
    return (
      (await withLock(`run-delivery:${runId}`, () =>
        authorizeRunLocked(runId, fn),
      )) ?? result
    );
  return result;
}
async function authorizeRunLocked<T>(
  runId: string,
  fn: () => Promise<T>,
  dispatchToken?: string,
  expectedPhase?: ImportPhase,
) {
  const row = (
    await pool.query<{ task_id: string | null }>(
      `SELECT task_id FROM runs WHERE id=$1`,
      [runId],
    )
  ).rows[0];
  if (!row?.task_id) {
    await logEvent(
      "warn",
      "tasks.legacy.held",
      "Queued work has no task authorization; start a reviewed task from Tasks",
      { run_id: runId },
    );
    return null;
  }
  const task = (
    await pool.query<TaskExecution>(
      `SELECT * FROM task_executions WHERE id=$1`,
      [row.task_id],
    )
  ).rows[0];
  // The direct, explicitly invoked CLI/test path uses the same capacity claim.
  // Queue consumers always provide their existing token instead.
  const token =
    dispatchToken ??
    (await claimPendingRuns(1, task.id, runId))[0]?.dispatch_token;
  if (!token) return null;
  const lease = (
    await pool.query(
      `SELECT 1 FROM runs WHERE id=$1 AND dispatch_token=$2
       AND status='queued' AND dispatch_until>now()
       AND ($3::text IS NULL OR dispatch_phase=$3)`,
      [runId, token, expectedPhase ?? null],
    )
  ).rowCount;
  if (!lease) return null;
  try {
    const live = await readSettings();
    return await withTaskContext(task, live, async () => {
      await checkpoint();
      // A lower live limit also constrains already published, unstarted work.
      // Running requests get priority and may finish at their safe boundary.
      const allowed = await importCapacityAllowed(runId, task, live);
      if (!allowed) return null;
      return fn();
    });
  } catch (error) {
    if (error instanceof TaskPaused) {
      await pauseTask(task.id, error.message);
      await pool.query(
        `UPDATE runs SET status='paused' WHERE id=$1 AND status IN ('queued','running','pending')`,
        [runId],
      );
      return null;
    }
    throw error;
  } finally {
    await releaseDispatch(runId, token, true);
  }
}
export async function scheduleTasks(now: Date) {
  const saved = await readSettings();
  if (
    saved.policy.paused ||
    saved.policy.imports !== "automatic" ||
    !saved.policy.scheduled_stores.length
  )
    return;
  await transaction(async (c) => {
    const row = (
      await c.query(`SELECT * FROM operational_settings WHERE id FOR UPDATE`)
    ).rows[0];
    if (
      row.revision !== saved.revision ||
      !row.next_due ||
      new Date(row.next_due) > now
    )
      return;
    const delay = now.getTime() - new Date(row.next_due).getTime();
    if (saved.policy.catch_up || delay < settings.scheduler.tick_ms) {
      for (const retailer of saved.policy.scheduled_stores.filter(
        (r) => settings.sources[r].enabled,
      )) {
        if (
          (
            await c.query(
              `SELECT 1 FROM task_executions WHERE kind='import' AND (state IN ('queued','running') OR (origin='scheduled' AND state='paused')) AND options->'retailers' ? $1`,
              [retailer],
            )
          ).rowCount
        )
          continue;
        await insertTask(
          c,
          {
            revision: saved.revision,
            kind: "import",
            retailers: [retailer],
            source_id: null,
            product_limit: null,
            use_ai: false,
            categories: [],
            max_cost_usd: 0,
            recheck: false,
            idempotency_key: randomUUID(),
          },
          "scheduler",
          saved,
          "scheduled",
        );
      }
    }
    await c.query(`UPDATE operational_settings SET next_due=$1 WHERE id`, [
      nextOccurrences(saved.policy.cron, now, 1)[0],
    ]);
  });
}
export async function automaticTasks() {
  return withLock("automatic-product-tasks", automaticTasksScoped);
}
async function automaticTasksScoped() {
  const saved = await readSettings();
  if (saved.policy.paused) return;
  const retailers = Object.keys(settings.sources).filter(
    (r) => settings.sources[r].enabled,
  ) as TaskCommand["retailers"];
  if (!retailers.length) return;
  for (const stage of [
    { kind: "categorize", ai: true },
    { kind: "match", ai: false },
    { kind: "match", ai: true },
  ] as const) {
    const { kind, ai } = stage,
      op = operationFor(kind);
    if (
      saved.policy[op] !== "automatic" ||
      (ai && !saved.policy.ai_enabled) ||
      (kind === "match" && ai && !saved.policy.ai_categories.length)
    )
      continue;
    if (
      (
        await pool.query(
          `SELECT 1 FROM task_executions WHERE origin='automatic' AND kind=$1 AND (options->>'use_ai')::boolean=$2 AND state IN ('queued','running','paused','cooldown')`,
          [kind, ai],
        )
      ).rowCount
    )
      continue;
    const eligible = (
      await pool.query(
        `SELECT 1 FROM store_products sp LEFT JOIN matching_work w ON w.store_product_id=sp.id WHERE sp.retailer=ANY($7::text[]) AND ${availableProductSql("sp")}
          ${kind === "categorize" ? "AND sp.category_pending AND sp.manual_family IS NULL" : ""}
          AND ${notHeldProductSql("$6")}
          AND (($5 AND sp.manual_family IS NULL) OR w.${kind === "categorize" ? "auto_category_epoch" : "auto_match_epoch"}=$1)
          AND sp.${kind === "categorize" ? "category_pending" : ai ? "ai_pending" : "rules_pending"} AND ($2=false OR (w.auto_ai_epoch=$3 AND sp.classified_family=ANY($4::text[]))) LIMIT 1`,
        [
          saved.epochs[op],
          kind === "match" && ai,
          saved.epochs.ai,
          saved.policy.ai_categories,
          kind === "categorize" && saved.category_backlog_active,
          kind,
          retailers,
        ],
      )
    ).rowCount;
    if (!eligible) continue;
    await createTask(
      {
        revision: saved.revision,
        kind,
        retailers,
        source_id: null,
        product_limit: saved.policy.default_product_limit,
        use_ai: ai,
        categories: kind === "match" && ai ? saved.policy.ai_categories : [],
        max_cost_usd: ai ? saved.policy.task_budget_usd : 0,
        recheck: false,
        idempotency_key: randomUUID(),
      },
      "worker",
      "automatic",
    );
  }
}
export async function pauseRun(id: string, reason: string) {
  const row = (
    await pool.query(
      `UPDATE runs SET status='paused',error=$2 WHERE id=$1 RETURNING task_id`,
      [id, reason],
    )
  ).rows[0];
  if (row?.task_id) await pauseTask(row.task_id, reason);
}
export async function categoryCounts(retailer: string, sourceId: string) {
  if (retailer && !Object.hasOwn(settings.sources, retailer))
    throw new TaskConflict("Unknown store");
  if (sourceId && !/^[a-f0-9-]{36}$/i.test(sourceId))
    throw new TaskConflict("Unknown catalog");
  const rows = (
    await pool.query(
      `SELECT sp.classified_family AS family,count(*)::int AS count FROM store_products sp
    WHERE ($1='' OR sp.retailer=$1) AND ${availableProductSql("sp", "nullif($2,'')")}
    GROUP BY sp.classified_family`,
      [retailer, sourceId],
    )
  ).rows;
  return {
    counts: rows.filter((r) => r.family !== null),
    uncategorized: rows.find((r) => r.family === null)?.count ?? 0,
  };
}
// Queue deliveries are at-least-once. Advisory locks and durable item counters
// make restart recovery safe without resetting completed work or authorizing legacy jobs.
export async function recoverAuthorizedWork() {
  const tasks = (
    await pool.query<{ id: string }>(
      `SELECT id FROM task_executions WHERE state IN ('queued','running') ORDER BY updated_at LIMIT $1`,
      [settings.queue.dispatch_batch],
    )
  ).rows;
  for (const task of tasks)
    await withLock(`task:${task.id}`, () =>
      pool.query(
        `UPDATE task_executions SET dispatch_until=NULL WHERE id=$1 AND state IN ('queued','running')`,
        [task.id],
      ),
    );
  const runs = (
    await pool.query<{ id: string }>(
      `SELECT id FROM runs WHERE (status IN ('queued','running') OR (status='pending' AND dispatch_token IS NOT NULL)) AND task_id IN(SELECT id FROM task_executions WHERE state IN ('queued','running')) ORDER BY created_at LIMIT $1`,
      [settings.queue.dispatch_batch],
    )
  ).rows;
  for (const run of runs)
    await withLock(`run-delivery:${run.id}`, () =>
      withLock(`run:${run.id}`, () =>
        pool.query(
          `UPDATE runs SET status=CASE WHEN retry_failures+(status='running')::int>$2 THEN 'failed' ELSE 'pending' END,
             dispatch_token=NULL,dispatch_until=NULL,dispatch_phase=NULL,
             finished_at=CASE WHEN retry_failures+(status='running')::int>$2 THEN now() ELSE finished_at END,
             error=CASE WHEN retry_failures+(status='running')::int>$2 THEN coalesce(error,'Worker stopped after the final permitted request without progress; resume explicitly to retry') ELSE error END,
             retry_failures=retry_failures+(status='running')::int
           WHERE id=$1 AND status IN ('pending','queued','running')`,
          [run.id, settings.queue.retry_limit],
        ),
      ),
    );
  await logEvent(
    tasks.length || runs.length ? "info" : "debug",
    "tasks.recovery.completed",
    "Worker recovery check completed; saved task progress is preserved",
    { tasks_checked: tasks.length, runs_checked: runs.length },
  );
}

export async function waitForRetry(id: string, error: unknown) {
  const row = (
    await pool.query<{
      attempts: number;
      retry_failures: number;
      next_attempt_at: Date | null;
    }>(
      // Source retries belong to the durable run, not a retailer queue job.
      // Releasing its dispatch reservation lets healthy stores proceed first.
      `UPDATE runs SET status=CASE WHEN retry_failures<$5 THEN 'pending' ELSE 'failed' END,
       finished_at=CASE WHEN retry_failures<$5 THEN NULL ELSE now() END,error=$2,
       next_attempt_at=CASE WHEN retry_failures<$5 THEN now()+$3*CASE WHEN $4 THEN power(2,least(retry_failures,$5)) ELSE 1 END*interval '1 second' ELSE NULL END,
       retry_failures=retry_failures+1
       WHERE id=$1 AND status='running' AND task_id IS NOT NULL
       RETURNING attempts,retry_failures,next_attempt_at`,
      [
        id,
        error instanceof Error ? error.message : String(error),
        settings.queue.retry_delay_seconds,
        settings.queue.retry_backoff,
        settings.queue.retry_limit,
      ],
    )
  ).rows[0];
  if (!row) throw new Error("Retry requires an active, authorized run");
  const metadata = {
    execution_turn: row.attempts,
    consecutive_failures: row.retry_failures,
    max_attempts: settings.queue.retry_limit + 1,
  };
  return row.next_attempt_at
    ? {
        ...metadata,
        retry_scheduled: true as const,
        next_attempt_at: row.next_attempt_at.toISOString(),
      }
    : { ...metadata, retry_scheduled: false as const, next_attempt_at: null };
}

export async function deferRun(id: string, until: string, reason: string) {
  await pool.query(
    `UPDATE runs SET status='pending',attempts=greatest(0,attempts-1),
       next_attempt_at=$2,error=$3,finished_at=NULL
     WHERE id=$1 AND status='running' AND task_id IS NOT NULL`,
    [id, until, reason],
  );
}
