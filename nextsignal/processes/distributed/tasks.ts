import {
  distributedProcess,
  ok,
  validateWith,
  type ProcessContext,
} from "@gotch/nextsignal";
import { z } from "zod";
import type { AppServices } from "@/nextsignal/services";
import { dispatchPending } from "./jobs";
const input = z.object({ task_id: z.uuid() });
export const taskJob = distributedProcess<
  { task_id: string },
  void,
  { task_id: string },
  AppServices
>({
  name: "tasks.job",
  transient: input,
  auth: () => ok(),
  validate: validateWith(input),
  handle: () => ok(),
  map: (_ctx, i) => i,
  async work(ctx, i) {
    return ctx.services.withLogContext(
      {
        logger: ctx.logger,
        process: ctx.metadata.processName,
        correlationId: ctx.metadata.correlationId,
        data: { task_id: i.task_id },
      },
      async () => {
        await ctx.services.tasks.executeTask(i.task_id);
        // Newly initialized catalog work can be published immediately by the
        // worker instead of waiting for another minute scheduler cycle.
        await dispatchPending(ctx, i.task_id);
        // A saved product batch can continue immediately within the same
        // reviewed task. Imports waiting on catalogs must not create a loop.
        await publishTasks(
          ctx,
          await ctx.services.tasks.pendingProductContinuation(i.task_id),
        );
        // A completed automatic category batch hands off the next authorized
        // batch immediately, while cooldowns still wait for the scheduler.
        await publishTasks(
          ctx,
          await ctx.services.tasks.pendingAutomaticCategoryContinuation(
            i.task_id,
          ),
        );
        return ok();
      },
    );
  },
});
export async function dispatchTasks(
  ctx: ProcessContext<AppServices>,
  taskId?: string,
) {
  await publishTasks(ctx, await ctx.services.tasks.pendingTasks(taskId));
}
async function publishTasks(
  ctx: ProcessContext<AppServices>,
  tasks: { id: string }[],
) {
  let failure: Error | undefined;
  for (const task of tasks) {
    try {
      const result = await ctx.mediator.dispatch("tasks.job", {
        task_id: task.id,
      });
      if (!result.ok)
        throw new Error("Task publication failed; checkpoint will be retried");
    } catch (error) {
      await ctx.services.tasks.releaseTaskDispatch(task.id);
      failure = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (failure) throw failure;
}
