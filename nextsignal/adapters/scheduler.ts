import type { SchedulerAdapter, ScheduleSubscription } from "@gotch/nextsignal";
import { boss, ensureQueue } from "./queue";
import { withLock } from "@/nextsignal/services/database";
import { settings } from "@/nextsignal/config";
const subscriptions: ScheduleSubscription[] = [];
export const schedulerAdapter: SchedulerAdapter = {
  schedule(subscription) {
    if (subscription.schedule.everyMs !== settings.scheduler.tick_ms)
      throw new Error(
        "Recurring process interval must match configured tick_ms",
      );
    subscriptions.push(subscription);
  },
  async start() {
    for (const sub of subscriptions) {
      const topic = `scheduler.${sub.process}`;
      await ensureQueue(topic);
      await boss.work(
        topic,
        {
          includeMetadata: true,
          localConcurrency: settings.queue.scheduler_concurrency,
          pollingIntervalSeconds: settings.queue.poll_seconds,
        },
        async (jobs) => {
          for (const job of jobs)
            await withLock(topic, () =>
              Promise.resolve(
                sub.handler({
                  trigger: "cron",
                  scheduledAt: job.createdOn.toISOString(),
                }),
              ),
            );
        },
      );
      await boss.schedule(
        topic,
        settings.scheduler.tick_cron,
        {},
        { tz: settings.app.timezone },
      );
      if (sub.schedule.runOnStart) await boss.send(topic, {});
    }
  },
  async stop() {
    for (const sub of subscriptions)
      await boss.offWork(`scheduler.${sub.process}`);
  },
};
