import { PgBoss } from "pg-boss";
import type { QueueAdapter, QueueSubscription } from "@gotch/nextsignal";
import { settings } from "@/nextsignal/config";
import { loggerAdapter } from "./logger";
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
    for (const sub of subscriptions) {
      const concurrency = settings.queue.concurrency[sub.topic];
      if (concurrency === undefined)
        throw new Error(`Missing queue.concurrency for ${sub.topic}`);
      await ensureQueue(sub.topic);
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
