import { settings } from "@/nextsignal/config";
import type { Run } from "@/nextsignal/domain/types";
import { pool, transaction } from "@/nextsignal/services/database";
export { claimPendingRuns, releaseDispatch } from "./import-dispatch";

export async function yieldRun(id: string) {
  await pool.query(
    `UPDATE runs SET status='pending',next_attempt_at=NULL,error=NULL WHERE id=$1 AND status='running'`,
    [id],
  );
  return { yielded: true };
}

export async function readyForPublication(id: string) {
  const result = await pool.query(
    `UPDATE runs SET status='pending',next_attempt_at=NULL,error=NULL,
       downloaded_at=coalesce(downloaded_at,clock_timestamp())
     WHERE id=$1 AND checkpoint->>'done'='true' RETURNING id`,
    [id],
  );
  if (!result.rowCount)
    throw new Error("A complete saved download is required before publication");
  return { ready_for_publication: true };
}

// Run state is independent of catalog contents. Keep its lifecycle and recovery
// queries here so processes describe orchestration rather than persistence.
export async function createRun(
  kind: Run["kind"],
  retailer: string | null,
  sourceId: string | null,
  parentId: string | null,
) {
  if (kind === "catalog") {
    const row = (
      await pool.query<Run>(
        "INSERT INTO runs(kind,retailer,source_id,parent_id,status,checkpoint) SELECT $1,$2,$3,$4,'pending',jsonb_build_object('source_url',url) FROM sources WHERE id=$3 RETURNING *",
        [kind, retailer, sourceId, parentId],
      )
    ).rows[0];
    if (!row) throw new Error("Catalog source not found");
    return row;
  }
  if (kind === "match") {
    return (
      await pool.query<Run>(
        `INSERT INTO runs(kind,retailer,source_id,parent_id,status,checkpoint)
         VALUES($1,$2,$3,$4,'pending',coalesce((SELECT checkpoint FROM runs WHERE id=$4 AND kind='match'),'{}'::jsonb)) RETURNING *`,
        [kind, retailer, sourceId, parentId],
      )
    ).rows[0];
  }
  return (
    await pool.query<Run>(
      "INSERT INTO runs(kind,retailer,source_id,parent_id,status) VALUES($1,$2,$3,$4,'pending') RETURNING *",
      [kind, retailer, sourceId, parentId],
    )
  ).rows[0];
}
export async function getRun(id: string) {
  const row = (await pool.query<Run>("SELECT * FROM runs WHERE id=$1", [id]))
    .rows[0];
  if (!row) throw new Error("Run not found");
  return row;
}

export async function startRun(id: string) {
  await pool.query(
    "UPDATE runs SET status='running',attempts=attempts+1,started_at=now(),error=NULL WHERE id=$1",
    [id],
  );
}

export async function completeRun(id: string, summary: unknown) {
  await pool.query(
    "UPDATE runs SET status='success',finished_at=now(),summary=$2 WHERE id=$1",
    [id, summary],
  );
}

export async function failRun(id: string, error: unknown) {
  await pool.query(
    "UPDATE runs SET status='failed',finished_at=now(),error=$2 WHERE id=$1",
    [id, error instanceof Error ? error.message : String(error)],
  );
}

export async function supersedeDisabled(id: string) {
  await pool.query(
    "UPDATE runs SET status='superseded',finished_at=now(),summary=$2 WHERE id=$1",
    [id, { reason: "Disabled in configuration" }],
  );
}

export async function pendingRuns(limit: number, taskId?: string) {
  return (
    await pool.query<Pick<Run, "id" | "kind" | "retailer">>(
      "SELECT id,kind,retailer FROM runs WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=now()) AND ($2::uuid IS NULL OR task_id=$2) AND task_id IN(SELECT id FROM task_executions WHERE state IN('queued','running')) ORDER BY row_number() OVER(PARTITION BY retailer ORDER BY created_at),created_at LIMIT $1",
      [limit, taskId ?? null],
    )
  ).rows;
}

export async function markQueued(id: string) {
  await pool.query(
    "UPDATE runs SET status='queued' WHERE id=$1 AND status='pending'",
    [id],
  );
}
const supersedeObsoleteSql = `UPDATE runs current SET status='superseded',finished_at=now(),
  summary=jsonb_build_object('reason',CASE WHEN NOT s.active THEN 'Catalog no longer offered by this supermarket' ELSE 'Newer catalog already published' END)
  FROM sources s LEFT JOIN runs published ON published.id=s.published_run
  WHERE current.id=$1 AND current.kind='catalog' AND current.source_id=s.id
    AND (NOT s.active OR coalesce((published.checkpoint->>'snapshot_started_at')::timestamptz,published.created_at)
      >coalesce((current.checkpoint->>'snapshot_started_at')::timestamptz,current.created_at))
    RETURNING current.*`;
export async function supersedeObsolete(run: Run): Promise<Run | null> {
  return (
    (await pool.query<Run>(supersedeObsoleteSql, [run.id])).rows[0] ?? null
  );
}
export async function restartCatalog(
  run: Run,
  reason: string,
): Promise<Run | null> {
  return transaction(async (c) => {
    const old = (
      await c.query<Run>("SELECT * FROM runs WHERE id=$1 FOR UPDATE", [run.id])
    ).rows[0];
    if (!old || old.kind !== "catalog" || !old.source_id || !old.retailer)
      throw new Error("Only catalog runs can restart their snapshot");
    const existing = (
      await c.query<Run>(
        "SELECT * FROM runs WHERE checkpoint->>'restarts_run'=$1 LIMIT 1",
        [old.id],
      )
    ).rows[0];
    if (existing) return existing;
    const obsolete = (await c.query<Run>(supersedeObsoleteSql, [old.id]))
      .rows[0];
    if (obsolete) return obsolete;
    const restarts = old.checkpoint.source_restarts ?? 0;
    if (
      typeof restarts !== "number" ||
      !Number.isSafeInteger(restarts) ||
      restarts < 0
    )
      throw new Error("Invalid catalog restart checkpoint");
    if (restarts >= settings.queue.retry_limit) return null;
    const next = (
      await c.query<Run>(
        "INSERT INTO runs(kind,retailer,source_id,parent_id,status,checkpoint) SELECT 'catalog',$1,$2,$3,'pending',jsonb_build_object('source_url',url,'source_restarts',$4::integer,'restarts_run',$5::text) FROM sources WHERE id=$2 RETURNING *",
        [
          old.retailer,
          old.source_id,
          old.parent_id ?? old.id,
          restarts + 1,
          old.id,
        ],
      )
    ).rows[0];
    if (!next) throw new Error("Catalog source not found");
    await c.query("UPDATE runs SET task_id=$2 WHERE id=$1", [
      next.id,
      old.task_id ?? null,
    ]);
    await c.query(
      "UPDATE runs SET status='superseded',finished_at=now(),error=$2,summary=$3 WHERE id=$1",
      [
        old.id,
        reason,
        { reason: "Fresh snapshot required", replacement_run_id: next.id },
      ],
    );
    return next;
  });
}
