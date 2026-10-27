import {
  distributedProcess,
  ok,
  validateWith,
  type ProcessContext,
} from "@gotch/nextsignal";
import { z } from "zod";
import type { AppServices } from "@/nextsignal/services";
const input = z.object({
  run_id: z.uuid(),
  // Old deliveries must drain harmlessly after a deployment. Only newly
  // reserved work carries a token and may execute.
  dispatch_token: z.uuid().optional(),
});
type Input = z.infer<typeof input>;
const job = (name: string, phase: "download" | "publish") =>
  distributedProcess<Input, void, Input, AppServices>({
    name,
    transient: input,
    auth: () => ok(),
    validate: validateWith(input),
    handle: () => ok(),
    map: (_ctx, i) => i,
    async work(ctx, i) {
      if (!i.dispatch_token) {
        await ctx.logger.debug?.({
          message:
            "Old import queue delivery skipped; durable task progress is preserved",
          data: { run_id: i.run_id, event: "catalog.dispatch.obsolete" },
        });
        return ok();
      }
      try {
        return (
          (await ctx.services.tasks.authorizeRun(
            i.run_id,
            () =>
              ctx.mediator.dispatch("catalog.execute", { run_id: i.run_id }),
            i.dispatch_token,
            phase,
          )) ?? ok()
        );
      } finally {
        // Refill the free slot fairly as soon as an attempt finishes. Retry
        // waits and cooling stores stay pending without occupying a queue.
        await dispatchPending(ctx);
      }
    },
  });
export const downloadJob = job("catalog.download", "download");
export const publicationJob = job("catalog.publish", "publish");
export async function dispatchPending(
  ctx: ProcessContext<AppServices>,
  taskId?: string,
) {
  const runs = await ctx.services.runs.claimPendingRuns(
    ctx.config.require<number>("queue.dispatch_batch"),
    taskId,
  );
  let failure: unknown;
  for (const run of runs) {
    try {
      const result = await ctx.mediator.dispatch(`catalog.${run.phase}`, {
        run_id: run.id,
        dispatch_token: run.dispatch_token,
      });
      if (!result.ok) throw new Error("Queue publication failed");
    } catch (error) {
      // Publication can fail after the broker accepted a message. Do not
      // revoke the reservation of a delivery another worker already owns.
      const released = await ctx.services.withLock(
        `run-delivery:${run.id}`,
        () => ctx.services.runs.releaseDispatch(run.id, run.dispatch_token),
      );
      failure = error;
      await ctx.logger.warn({
        message:
          "Import queue publication could not be confirmed; saved work remains recoverable",
        data: {
          run_id: run.id,
          retailer: run.retailer,
          event: "catalog.dispatch.failed",
          reservation_released: released !== null,
        },
        error,
      });
    }
  }
  if (failure) throw failure;
}
