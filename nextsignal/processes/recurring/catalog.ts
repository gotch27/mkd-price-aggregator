import { recurringProcess, interval, ok } from "@gotch/nextsignal";
import { settings } from "@/nextsignal/config";
import type { AppServices } from "@/nextsignal/services";
import { dispatchTasks } from "../distributed/tasks";
import { dispatchPending } from "../distributed/jobs";
import { replayLogs } from "@/nextsignal/adapters/logger";
export const catalogTick = recurringProcess<void, AppServices>({
  name: "catalog.tick",
  schedule: interval({
    everyMs: settings.scheduler.tick_ms,
    runOnStart: settings.scheduler.run_on_start,
  }),
  overlap: "skip",
  async handle(ctx) {
    return ctx.services.withLogContext(
      {
        logger: ctx.logger,
        process: ctx.metadata.processName,
        correlationId: ctx.metadata.correlationId,
      },
      async () => {
        await ctx.services.catalog.seedRetailers();
        // Settings reads fail closed. Startup is never a grant to the old backlog.
        await ctx.services.taskSettings.readSettings();
        await ctx.services.brandFacts.refreshBatch();
        await ctx.services.tasks.scheduleTasks(new Date());
        await ctx.services.tasks.automaticTasks();
        await dispatchTasks(ctx);
        await dispatchPending(ctx);
        await ctx.services.scheduling.maintenance();
        await ctx.services.statistics.refreshProductStatistics();
        await replayLogs();
        return ok();
      },
    );
  },
});
