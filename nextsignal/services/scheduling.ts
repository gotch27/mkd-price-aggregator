import { CronExpressionParser } from "cron-parser";
import { settings } from "@/nextsignal/config";
import { transaction, pool, withLock } from "./database";
export function nextOccurrence(
  expression: string,
  timezone: string,
  after: Date,
) {
  return CronExpressionParser.parse(expression, {
    tz: timezone,
    currentDate: after,
  })
    .next()
    .toDate();
}
export async function enqueueDue(now: Date) {
  await transaction(async (c) => {
    const retailers = (
      await c.query(
        "SELECT * FROM retailers WHERE enabled FOR UPDATE SKIP LOCKED",
      )
    ).rows;
    for (const retailer of retailers) {
      const cfg = settings.sources[retailer.slug],
        expression = cfg.cron === null ? settings.scheduler.cron : cfg.cron;
      if (!retailer.next_due) {
        await c.query("UPDATE retailers SET next_due=$2 WHERE slug=$1", [
          retailer.slug,
          nextOccurrence(expression, settings.app.timezone, now),
        ]);
        continue;
      }
      if (new Date(retailer.next_due) > now) continue;
      if (
        (
          await c.query(
            "SELECT 1 FROM runs WHERE retailer=$1 AND kind IN('discover','catalog') AND status IN('pending','queued','running') LIMIT 1",
            [retailer.slug],
          )
        ).rowCount
      )
        continue;
      if (settings.scheduler.catch_up)
        await c.query(
          "INSERT INTO runs(kind,retailer,scheduled_for,status) VALUES('discover',$1,$2,'pending') ON CONFLICT DO NOTHING",
          [retailer.slug, retailer.next_due],
        );
      else if (
        now.getTime() - new Date(retailer.next_due).getTime() <
        settings.scheduler.tick_ms
      )
        await c.query(
          "INSERT INTO runs(kind,retailer,scheduled_for,status) VALUES('discover',$1,$2,'pending') ON CONFLICT DO NOTHING",
          [retailer.slug, retailer.next_due],
        );
      await c.query("UPDATE retailers SET next_due=$2 WHERE slug=$1", [
        retailer.slug,
        nextOccurrence(expression, settings.app.timezone, now),
      ]);
    }
  });
}
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

export async function recoverOrphans() {
  if (!settings.queue.recover_orphans) return;
  const { rows } = await pool.query(
    "SELECT id FROM runs WHERE status='running'",
  );
  for (const run of rows)
    await withLock(`run:${run.id}`, () =>
      pool.query(
        "UPDATE runs SET status='pending' WHERE id=$1 AND status='running'",
        [run.id],
      ),
    );
}
