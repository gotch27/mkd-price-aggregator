import {
  distributedProcess,
  ok,
  validateWith,
  type ProcessContext,
} from "@gotch/nextsignal";
import { z } from "zod";
import type { AppServices } from "@/nextsignal/services";
import { settings } from "@/nextsignal/config";
const input = z.object({ run_id: z.uuid() });
const job = (name: string) =>
  distributedProcess<{ run_id: string }, void, { run_id: string }, AppServices>(
    {
      name,
      transient: input,
      auth: () => ok(),
      validate: validateWith(input),
      handle: () => ok(),
      map: (_ctx, i) => i,
      async work(ctx, i) {
        return ctx.mediator.dispatch("catalog.execute", i);
      },
    },
  );
export const runJob = job("catalog.job");
export const matchJob = job("catalog.match");
export const retailerJobs = Object.keys(settings.sources).map((retailer) =>
  job(`catalog.${retailer}.job`),
);
export async function dispatchPending(ctx: ProcessContext<AppServices>) {
  const runs = await ctx.services.runs.pendingRuns(
    ctx.config.require<number>("queue.dispatch_batch"),
  );
  for (const run of runs) {
    const result = await ctx.mediator.dispatch(
      run.kind === "match"
        ? "catalog.match"
        : run.kind === "catalog"
          ? `catalog.${run.retailer}.job`
          : "catalog.job",
      {
        run_id: run.id,
      },
    );
    if (!result.ok) throw new Error("Queue publication failed");
    await ctx.services.runs.markQueued(run.id);
  }
}
