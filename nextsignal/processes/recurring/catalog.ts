import { recurringProcess, interval, ok } from "@gotch/nextsignal";
import { settings } from "@/nextsignal/config";
import type { AppServices } from "@/nextsignal/services";
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
    await ctx.services.catalog.seedRetailers();
    await ctx.services.scheduling.enqueueDue(new Date());
    await ctx.services.scheduling.recoverOrphans();
    await dispatchPending(ctx);
    if (await ctx.services.browser.refreshBrowser())
      await ctx.logger.info({ message: "Product browser refreshed" });
    const indexed = await ctx.services.localMatching.indexLocalProducts();
    if (indexed)
      await ctx.logger.info({
        message: "Local product keys indexed",
        data: { count: indexed },
      });
    await ctx.services.scheduling.maintenance();
    await replayLogs();
    return ok();
  },
});
