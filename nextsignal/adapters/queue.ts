import { PgBoss } from "pg-boss";
import type { QueueAdapter, QueueSubscription } from "@gotch/nextsignal";
import { settings } from "@/nextsignal/config";
import { loggerAdapter } from "./logger";
import { pool } from "@/nextsignal/services/database";
export const boss = new PgBoss({
  connectionString: settings.database.url,
  max: settings.queue.database_pool_size,
});
let started: Promise<unknown> | undefined;
export function startBoss() {
  return (started ??= boss.start().catch((e) => {
    started = undefined;
    throw e;
  }));
}
const subscriptions: QueueSubscription[] = [];
export async function ensureQueue(topic: string) {
  await startBoss();
  await boss.createQueue(topic, {
    retryLimit: settings.queue.retry_limit,
    retryDelay: settings.queue.retry_delay_seconds,
    retryBackoff: settings.queue.retry_backoff,
    heartbeatSeconds: settings.queue.heartbeat_seconds,
    expireInSeconds: settings.queue.expire_seconds,
    retentionSeconds: settings.queue.retention_seconds,
    deleteAfterSeconds: settings.queue.retention_seconds,
  });
}

export async function cancelObsoleteCatalogJobs(topic: string) {
  if (!/^catalog\.(?:job|match|download|publish|[a-z]+\.job)$/.test(topic))
    return;
  const stale = (
    await pool.query<{ id: string }>(
      `SELECT j.id FROM pgboss.job j LEFT JOIN runs r
         ON r.id::text=j.data->'payload'->>'run_id'
       LEFT JOIN task_executions t ON t.id=r.task_id
       WHERE j.name=$1 AND j.state IN ('created','retry')
         AND (j.data->'payload'->>'dispatch_token'=r.dispatch_token::text
           AND r.status='queued' AND r.dispatch_until>now()
           AND t.state IN ('queued','running')) IS NOT TRUE`,
      [topic],
    )
  ).rows;
  if (!stale.length) return;
  await boss.cancel(
    topic,
    stale.map((job) => job.id),
  );
  await loggerAdapter.info({
    message:
      "Obsolete import queue deliveries removed; saved task progress is preserved",
    data: {
      event: "catalog.dispatch.drained",
      topic,
      deliveries: stale.length,
    },
  });
}
export const queueAdapter: QueueAdapter = {
  async publish(message) {
    await ensureQueue(message.process);
    await boss.send(message.process, message);
  },
  subscribe(subscription) {
    subscriptions.push(subscription);
  },
  async start() {
    await startBoss();
    for (const topic of [
      "catalog.job",
      "catalog.match",
      ...Object.keys(settings.sources).map((r) => `catalog.${r}.job`),
    ])
      await cancelObsoleteCatalogJobs(topic);
    for (const sub of subscriptions) {
      const concurrency = settings.queue.concurrency[sub.topic];
      if (concurrency === undefined)
        throw new Error(`Missing queue.concurrency for ${sub.topic}`);
      await ensureQueue(sub.topic);
      await cancelObsoleteCatalogJobs(sub.topic);
      await boss.work(
        sub.topic,
        {
          localConcurrency: concurrency,
          heartbeatRefreshSeconds: settings.queue.heartbeat_refresh_seconds,
          pollingIntervalSeconds: settings.queue.poll_seconds,
        },
        async (jobs) => {
          for (const job of jobs)
            await sub.handler(job.data as Parameters<typeof sub.handler>[0]);
        },
      );
    }
  },
  async stop() {
    if (started) await boss.stop({ timeout: settings.queue.stop_ms });
    started = undefined;
  },
};
boss.on("error", (error) => {
  void loggerAdapter.error({ message: "Queue error", error });
});
