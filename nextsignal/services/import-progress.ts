import { pool } from "./database";
import type { PoolClient } from "pg";

export type ImportProgress = {
  waiting: number;
  running: number;
  queued: number;
  paused: number;
  failed: number;
  failed_catalogs: number;
  failed_discoveries: number;
  failure_stores: string[];
  done: number;
  failure: {
    id: string;
    retailer: string | null;
    error: string | null;
    kind: string;
    status: string;
  } | null;
};

export type ImportRetryCandidate = {
  id: string;
  kind: "catalog" | "discover";
  retailer: string;
  source_id: string | null;
  parent_id: string | null;
  created_at: Date;
  checkpoint: Record<string, unknown>;
  fresh_snapshot: boolean;
};

// Static SQL shared by progress, failure labels and retry selection. Follow only
// explicit links inside this task; UNION also terminates malformed history cycles.
const importRunGraph = `WITH RECURSIVE scoped AS MATERIALIZED (
  SELECT id,retailer,source_id,parent_id,kind,status,error,summary,checkpoint,finished_at,created_at
  FROM runs WHERE task_id=$1 AND kind IN ('catalog','discover')
), followups AS (
  SELECT parent.id AS parent_id,child.id AS child_id
  FROM scoped parent JOIN scoped child
    ON child.checkpoint->>'confirmation_of'=parent.id::text
  UNION
  SELECT parent.id,child.id FROM scoped parent JOIN scoped child
    ON parent.summary->>'replacement_run_id'=child.id::text
), descendants AS (
  SELECT id AS root_id,id AS run_id FROM scoped WHERE status='quarantined'
  UNION
  SELECT d.root_id,f.child_id FROM descendants d JOIN followups f ON f.parent_id=d.run_id
), evaluated AS (
  SELECT r.*,
    status='failed' OR (status='quarantined' AND NOT EXISTS (
      SELECT 1 FROM descendants d JOIN scoped resolution ON resolution.id=d.run_id
      WHERE d.root_id=r.id AND (
        resolution.status IN ('pending','queued','running','paused','success')
        OR (resolution.status='superseded' AND NOT(resolution.summary ? 'replacement_run_id'))
      )
    )) AS unresolved_failure
  FROM scoped r
)`;

// Derive both the totals and displayed failure from the same database snapshot.
// A quarantined snapshot is historical once its explicit confirmation/replacement
// chain is active or completed. Do not treat a different task's success as a grant
// to rewrite this task's outcome or history.
export async function readImportProgress(
  taskId: string,
): Promise<ImportProgress> {
  return (
    await pool.query<ImportProgress>(
      `${importRunGraph} SELECT
        count(*) FILTER(WHERE status IN ('pending','queued','running'))::int AS waiting,
        count(*) FILTER(WHERE status='running')::int AS running,
        count(*) FILTER(WHERE status='queued')::int AS queued,
        count(*) FILTER(WHERE status='paused')::int AS paused,
        count(*) FILTER(WHERE unresolved_failure)::int AS failed,
        count(DISTINCT source_id) FILTER(WHERE unresolved_failure AND kind='catalog')::int AS failed_catalogs,
        count(DISTINCT retailer) FILTER(WHERE unresolved_failure AND kind='discover')::int AS failed_discoveries,
        ARRAY(SELECT DISTINCT retailer FROM evaluated WHERE unresolved_failure AND retailer IS NOT NULL ORDER BY retailer) AS failure_stores,
        count(*) FILTER(WHERE status='success' OR (status='superseded' AND NOT(summary ? 'replacement_run_id')))::int AS done,
        (SELECT jsonb_build_object('id',id,'retailer',retailer,'error',error,'kind',kind,'status',status)
          FROM evaluated WHERE unresolved_failure
          ORDER BY finished_at DESC NULLS LAST,created_at DESC,id LIMIT 1) AS failure
      FROM evaluated`,
      [taskId],
    )
  ).rows[0];
}

// Call within the task-control transaction, after locking its task row. Return
// only failed leaves, so a quarantine and its failed confirmation cannot both
// create duplicate retries. Rejected complete snapshots need a new baseline;
// ordinary download failures may retain their saved pages/checkpoint.
export async function readImportRetryCandidates(
  client: PoolClient,
  taskId: string,
): Promise<ImportRetryCandidate[]> {
  return (
    await client.query<ImportRetryCandidate>(
      `${importRunGraph}
       SELECT current.id,current.kind,current.retailer,current.source_id,current.parent_id,
         current.created_at,current.checkpoint,current.status='quarantined' AS fresh_snapshot
       FROM runs current JOIN evaluated candidate ON candidate.id=current.id
       WHERE candidate.unresolved_failure AND NOT EXISTS (
         SELECT 1 FROM descendants d JOIN evaluated child ON child.id=d.run_id
         WHERE d.root_id=current.id AND d.run_id<>current.id AND child.unresolved_failure
       )
       ORDER BY current.created_at,current.id FOR UPDATE OF current`,
      [taskId],
    )
  ).rows;
}
