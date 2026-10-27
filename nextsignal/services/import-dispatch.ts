import { randomUUID } from "node:crypto";
import { settings } from "@/nextsignal/config";
import { logEvent } from "@/nextsignal/adapters/log-context";
import type { TaskExecution } from "@/nextsignal/domain/task-settings";
import { TaskPaused } from "@/nextsignal/domain/task-settings";
import { pool, transaction } from "./database";
import { assertPermission } from "./task-context";
import { readSettings } from "./task-settings";
import { blockedRetailers } from "./source-health";
import type { SavedTaskSettings } from "@/nextsignal/domain/task-settings";

export type ImportPhase = "download" | "publish";

export type ImportDispatch = {
  id: string;
  kind: "catalog" | "discover";
  retailer: string;
  dispatch_token: string;
  phase: ImportPhase;
};

export function importLimits(task: TaskExecution, live: SavedTaskSettings) {
  return {
    downloads: Math.min(
      task.policy.parallel_imports,
      live.policy.parallel_imports,
      settings.queue.concurrency["catalog.download"],
    ),
    perStore: Math.min(
      task.policy.per_store_downloads,
      live.policy.per_store_downloads,
    ),
    publications: settings.ingestion.parallel_publications,
  };
}

type ActiveImport = {
  id: string;
  kind: string;
  retailer: string;
  source_id: string | null;
  dispatch_phase: ImportPhase;
};

// Used again when a queued delivery starts: lowering limits cannot leave older
// reservations authorized to exceed the new limits.
export async function importCapacityAllowed(
  id: string,
  task: TaskExecution,
  live: SavedTaskSettings,
) {
  const active = (
    await pool.query<ActiveImport>(
      `SELECT r.id,r.kind,r.retailer,r.source_id,r.dispatch_phase FROM runs r JOIN task_executions t ON t.id=r.task_id
     WHERE r.kind IN ('catalog','discover') AND r.dispatch_token IS NOT NULL
       AND (r.status='running' OR (r.status IN ('queued','pending') AND t.state IN ('queued','running')))
     ORDER BY (r.status='running') DESC,r.dispatched_at,r.id`,
    )
  ).rows;
  const current = active.find((r) => r.id === id);
  if (!current) return false;
  const limits = importLimits(task, live);
  const lane = active.filter(
    (r) => r.dispatch_phase === current.dispatch_phase,
  );
  if (
    !lane
      .slice(
        0,
        current.dispatch_phase === "publish"
          ? limits.publications
          : limits.downloads,
      )
      .some((r) => r.id === id)
  )
    return false;
  return (
    current.dispatch_phase === "publish" ||
    lane
      .filter((r) => r.retailer === current.retailer)
      .slice(0, limits.perStore)
      .some((r) => r.id === id)
  );
}

// All publishers, including immediate task starts and worker follow-ups, share
// this short transaction. No queue or source HTTP call runs inside it.
export async function claimPendingRuns(
  limit: number,
  taskId?: string,
  runId?: string,
) {
  const live = await readSettings();
  const cooling = (await blockedRetailers()).map((item) => item.retailer);
  let recovered: {
    id: string;
    retailer: string;
    status: string;
    attempts: number;
  }[] = [];
  let inactive: { id: string; retailer: string }[] = [];
  const claimed = await transaction(async (c) => {
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('import-dispatch',0))`,
    );
    // Either publisher or worker may disappear while another worker stays up.
    // A live delivery holds BOTH advisory locks throughout execution, even if
    // its elapsed time exceeds the queue lease. Never steal that work.
    recovered = (
      await c.query<{
        id: string;
        retailer: string;
        status: string;
        attempts: number;
      }>(
        `UPDATE runs r SET
         status=CASE WHEN r.retry_failures+(r.status='running')::int>$1 THEN 'failed'
           WHEN $2 OR t.state NOT IN ('queued','running') THEN 'paused'
           ELSE 'pending' END,
         dispatch_token=NULL,dispatch_until=NULL,dispatch_phase=NULL,
         finished_at=CASE WHEN r.retry_failures+(r.status='running')::int>$1 THEN now() ELSE r.finished_at END,
         retry_failures=r.retry_failures+(r.status='running')::int,
         error=CASE WHEN r.status='running'
           THEN coalesce(r.error,'Worker stopped; saved catalog pages are preserved') ELSE r.error END
       FROM task_executions t
       WHERE r.task_id=t.id AND r.status IN ('pending','queued','running') AND r.dispatch_token IS NOT NULL AND r.dispatch_until<now()
         AND pg_try_advisory_xact_lock(hashtextextended('run-delivery:'||r.id::text,0))
         AND pg_try_advisory_xact_lock(hashtextextended('run:'||r.id::text,0))
       RETURNING r.id,r.retailer,r.status,r.attempts`,
        [
          settings.queue.retry_limit,
          live.policy.paused || live.policy.imports === "off",
        ],
      )
    ).rows;
    // Discovery can retire a price source after its work was queued or paused.
    // Resolve that local work without granting execution permission or touching
    // a live handler. A finishing handler may still report pending/queued while
    // holding its delivery, run or source lock.
    inactive = (
      await c.query<{ id: string; retailer: string }>(
        `UPDATE runs r SET status='superseded',finished_at=clock_timestamp(),
          dispatch_token=NULL,dispatch_until=NULL,dispatch_phase=NULL,next_attempt_at=NULL,
          summary=r.summary||jsonb_build_object('reason','Catalog no longer offered','source_inactive',true)
        FROM sources s WHERE r.source_id=s.id AND NOT s.active AND r.kind='catalog'
          AND r.status IN ('pending','queued','paused')
          AND pg_try_advisory_xact_lock(hashtextextended('run-delivery:'||r.id::text,0))
          AND pg_try_advisory_xact_lock(hashtextextended('run:'||r.id::text,0))
          AND pg_try_advisory_xact_lock(hashtextextended('source:'||r.source_id::text,0))
        RETURNING r.id,r.retailer`,
      )
    ).rows;
    // State recovery is local and safe while paused. It never grants permission
    // to publish a task or make an external request.
    if (live.policy.paused || live.policy.imports === "off") return [];
    const active = (
      await c.query<ActiveImport>(
        `SELECT r.id,r.kind,r.retailer,r.source_id,r.dispatch_phase FROM runs r JOIN task_executions t ON t.id=r.task_id
         WHERE r.kind IN ('catalog','discover') AND r.dispatch_token IS NOT NULL
           AND (r.status='running' OR (r.status IN ('queued','pending') AND t.state IN ('queued','running')))`,
      )
    ).rows;
    const busySources = new Set(active.map((r) => r.source_id).filter(Boolean));
    const downloads = active.filter((r) => r.dispatch_phase === "download");
    let downloadCount = downloads.length;
    let publicationCount = active.filter(
      (r) => r.dispatch_phase === "publish",
    ).length;
    const storeDownloads = new Map<string, number>();
    for (const r of downloads)
      storeDownloads.set(r.retailer, (storeDownloads.get(r.retailer) ?? 0) + 1);
    const discoveryStores = new Set(
      downloads.filter((r) => r.kind === "discover").map((r) => r.retailer),
    );
    const readyCount = (
      await c.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM runs r JOIN task_executions t ON t.id=r.task_id
       WHERE r.kind='catalog' AND r.status IN ('pending','queued','running')
         AND r.checkpoint->>'done'='true' AND t.state IN ('queued','running')
         AND (r.dispatch_phase IS DISTINCT FROM 'download' OR r.dispatch_token IS NULL)`,
      )
    ).rows[0].count;
    // Keep chain fairness ahead of per-catalog priority. Within a chain,
    // continue healthy saved snapshots before opening more catalogs. Normal
    // yields reuse the download slots instead of opening every chain catalog.
    // Failed requests still yield to fresh/healthy work while waiting to retry.
    const candidates = (
      await c.query<{
        id: string;
        kind: ImportDispatch["kind"];
        retailer: string;
        task: TaskExecution;
        source_id: string | null;
        phase: ImportPhase;
      }>(
        `SELECT r.id,r.kind,r.retailer,r.source_id,to_jsonb(t) AS task,
          CASE WHEN r.kind='catalog' AND r.checkpoint->>'done'='true' THEN 'publish' ELSE 'download' END AS phase
         FROM runs r JOIN task_executions t ON t.id=r.task_id
         LEFT JOIN (SELECT retailer,max(dispatched_at) AS last_served FROM runs GROUP BY retailer) fairness ON fairness.retailer=r.retailer
         WHERE r.status='pending' AND r.dispatch_token IS NULL AND r.kind IN ('discover','catalog')
           AND (r.kind='discover' OR EXISTS(SELECT 1 FROM sources source WHERE source.id=r.source_id AND source.active))
           AND t.state IN ('queued','running')
           AND ($1::uuid IS NULL OR r.task_id=$1)
           AND ($3::uuid IS NULL OR r.id=$3)
           AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=now())
           AND ((r.kind='catalog' AND r.checkpoint->>'done'='true') OR NOT(r.retailer=ANY($2::text[])))
         ORDER BY coalesce(r.checkpoint->>'done'='true',false) DESC,fairness.last_served NULLS FIRST,
           CASE
             WHEN r.next_attempt_at IS NOT NULL OR r.retry_failures>0 THEN 2
             WHEN r.kind='catalog' AND coalesce((r.checkpoint->>'pages_saved')::integer,0)>0 THEN 0
             ELSE 1
           END,r.created_at,r.id
         FOR UPDATE OF r`,
        [taskId ?? null, cooling, runId ?? null],
      )
    ).rows;
    const claimed: ImportDispatch[] = [];
    for (const run of candidates) {
      if (claimed.length >= limit) break;
      if (run.source_id && busySources.has(run.source_id)) continue;
      try {
        assertPermission(run.task, live);
      } catch (error) {
        if (error instanceof TaskPaused) continue;
        throw error;
      }
      const limits = importLimits(run.task, live);
      if (run.phase === "publish") {
        if (publicationCount >= limits.publications) continue;
      } else {
        if (
          downloadCount >= limits.downloads ||
          (storeDownloads.get(run.retailer) ?? 0) >= limits.perStore ||
          readyCount + downloadCount >= settings.ingestion.max_ready_catalogs ||
          (run.kind === "discover" && discoveryStores.has(run.retailer))
        )
          continue;
      }
      // Keep a finishing handler's run/source locks out of a new reservation.
      // Explicit CLI execution already owns the run-delivery lock itself.
      if (
        runId === undefined &&
        !(
          await c.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
            [`run-delivery:${run.id}`],
          )
        ).rows[0].acquired
      )
        continue;
      if (
        run.source_id &&
        !(
          await c.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
            [`source:${run.source_id}`],
          )
        ).rows[0].acquired
      )
        continue;
      const token = randomUUID();
      await c.query(
        `UPDATE runs SET status='queued',dispatch_token=$2,
           dispatch_until=now()+$3*interval '1 second',dispatched_at=clock_timestamp(),dispatch_phase=$4
         WHERE id=$1`,
        [run.id, token, settings.queue.dispatch_lease_seconds, run.phase],
      );
      claimed.push({
        id: run.id,
        kind: run.kind,
        retailer: run.retailer,
        dispatch_token: token,
        phase: run.phase,
      });
      if (run.source_id) busySources.add(run.source_id);
      if (run.phase === "publish") publicationCount++;
      else {
        downloadCount++;
        storeDownloads.set(
          run.retailer,
          (storeDownloads.get(run.retailer) ?? 0) + 1,
        );
        if (run.kind === "discover") discoveryStores.add(run.retailer);
      }
    }
    return claimed;
  });
  if (recovered.length)
    await logEvent(
      "info",
      "catalog.dispatch.recovered",
      "Expired import reservations recovered; saved progress is preserved",
      { runs: recovered },
    );
  if (inactive.length)
    await logEvent(
      "info",
      "catalog.dispatch.inactive_skipped",
      "Queued work for catalogs no longer offered was skipped; history is preserved",
      { runs: inactive },
    );
  return claimed;
}

export async function releaseDispatch(
  id: string,
  token: string,
  executionSettled = false,
) {
  await pool.query(
    `UPDATE runs SET status=CASE
         WHEN status='running' AND $3 THEN CASE WHEN retry_failures+1>$4 THEN 'failed' ELSE 'pending' END
         WHEN status='queued' THEN 'pending' ELSE status END,
       next_attempt_at=CASE WHEN status='running' AND $3 AND retry_failures+1<=$4
         THEN greatest(next_attempt_at,now()+$5*interval '1 second') ELSE next_attempt_at END,
       finished_at=CASE WHEN status='running' AND $3 AND retry_failures+1>$4 THEN now() ELSE finished_at END,
       retry_failures=retry_failures+CASE WHEN status='running' AND $3 THEN 1 ELSE 0 END,
       error=CASE WHEN status='running' AND $3
         THEN coalesce(error,'Attempt interrupted; saved catalog pages are preserved') ELSE error END,
       dispatch_token=NULL,dispatch_until=NULL,dispatch_phase=NULL
     WHERE id=$1 AND dispatch_token=$2`,
    [
      id,
      token,
      executionSettled,
      settings.queue.retry_limit,
      settings.queue.retry_delay_seconds,
    ],
  );
}
