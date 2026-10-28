import { settings } from "@/nextsignal/config";
import { pool } from "./database";

export async function maintenance() {
  await pool.query(
    "DELETE FROM logs WHERE created_at<now()-(CASE WHEN level='debug' THEN $1::int ELSE $2::int END)*interval '1 day'",
    [settings.logging.debug_days, settings.logging.operational_days],
  );
  await pool.query(
    `DELETE FROM artifacts a WHERE created_at<now()-$1*interval '1 hour'
     AND NOT EXISTS(SELECT 1 FROM runs r JOIN task_executions t ON t.id=r.task_id
       WHERE r.id=a.run_id AND r.status NOT IN ('success','superseded')
         AND t.kind IN ('discover','import') AND t.state IN ('queued','running','paused','failed'))`,
    [settings.ingestion.artifact_hours],
  );
  await pool.query(
    `DELETE FROM staging WHERE run_id IN(SELECT r.id FROM runs r
     WHERE r.status IN('success','superseded','failed','quarantined')
       AND r.finished_at<now()-$1*interval '1 hour'
       AND NOT EXISTS(SELECT 1 FROM task_executions t WHERE t.id=r.task_id
         AND r.status IN ('failed','quarantined') AND t.kind IN ('discover','import')
         AND t.state IN ('queued','running','paused','failed'))
       AND NOT EXISTS(SELECT 1 FROM runs pending
         WHERE pending.status IN('pending','queued','running','paused')
           AND pending.checkpoint->>'confirmation_of'=r.id::text))`,
    [settings.ingestion.staging_hours],
  );
  await pool.query(
    `UPDATE runs r SET checkpoint='{}' WHERE r.status='failed'
     AND r.finished_at<now()-$1*interval '1 hour'
     AND NOT EXISTS(SELECT 1 FROM staging s WHERE s.run_id=r.id)
     AND NOT EXISTS(SELECT 1 FROM task_executions t WHERE t.id=r.task_id
       AND t.kind IN ('discover','import') AND t.state IN ('queued','running','paused','failed'))`,
    [settings.ingestion.staging_hours],
  );
}
