import {
  apiProcess,
  value,
  fail,
  ok,
  validateWith,
  notFound,
  type ProcessContext,
} from "@gotch/nextsignal";
import { z } from "zod";
import {
  operationalSchema,
  taskCommandSchema,
  TaskConflict,
  TaskPaused,
  retailerIds,
  type TaskCommand,
  type OperationalPolicy,
} from "@/nextsignal/domain/task-settings";
import { settings } from "@/nextsignal/config";
import type { AppServices } from "@/nextsignal/services";
import { families } from "@/nextsignal/domain/matching";
import { dispatchTasks } from "@/nextsignal/processes/distributed/tasks";

async function publishReviewedTask(
  ctx: ProcessContext<AppServices>,
  id: string,
) {
  try {
    await dispatchTasks(ctx, id);
  } catch (error) {
    // Acceptance is already durable. A temporary queue outage must not turn a
    // saved task into an ambiguous failure or hold its dispatch lease for hours.
    await ctx.logger.warn({
      message: "Task saved; worker dispatch will retry",
      data: { task_id: id },
      error,
    });
  }
}
const authorize = (ctx: ProcessContext<AppServices>) =>
  ctx.auth.requireUser!(ctx);
const pages = z.object({
  page: z.coerce.number().int().positive(),
  size: z.coerce.number().int().min(1).max(50),
});
async function response(
  ctx: ProcessContext<AppServices>,
  fn: () => Promise<unknown>,
) {
  return ctx.services.withLogContext(
    {
      logger: ctx.logger,
      process: ctx.metadata.processName,
      correlationId: ctx.metadata.correlationId,
    },
    async () => {
      try {
        return value(await fn());
      } catch (error) {
        if (error instanceof TaskConflict || error instanceof TaskPaused)
          return fail(error.message);
        throw error;
      }
    },
  );
}
export const taskSettingsRead = apiProcess<void, unknown, AppServices>({
  name: "tasks.settingsRead",
  auth: authorize,
  validate: () => ok(),
  async handle(ctx) {
    return value(await ctx.services.taskSettings.settingsView());
  },
});
export const taskSettingsSave = apiProcess<
  {
    revision: number;
    policy: OperationalPolicy;
    authorize_category_backlog?: boolean;
  },
  unknown,
  AppServices
>({
  name: "tasks.settingsSave",
  auth: authorize,
  validate: validateWith(
    z.object({
      revision: z.number().int().positive(),
      policy: operationalSchema,
      authorize_category_backlog: z.boolean().optional(),
    }),
  ),
  handle: (ctx, i) =>
    response(ctx, () =>
      ctx.services.taskSettings.saveSettings(
        i.revision,
        i.policy,
        settings.auth.username,
        i.authorize_category_backlog,
      ),
    ),
});
export const taskHistory = apiProcess<
  z.infer<typeof pages>,
  unknown,
  AppServices
>({
  name: "tasks.settingsHistory",
  auth: authorize,
  validate: validateWith(pages),
  async handle(ctx, i) {
    const p = pages.parse(i);
    return value(
      await ctx.services.taskSettings.settingsHistory(p.page, p.size),
    );
  },
});
export const taskList = apiProcess<z.infer<typeof pages>, unknown, AppServices>(
  {
    name: "tasks.list",
    auth: authorize,
    validate: validateWith(pages),
    async handle(ctx, i) {
      const p = pages.parse(i);
      return value(await ctx.services.tasks.listTasks(p.page, p.size));
    },
  },
);
const resultQuery = pages.extend({
  size: z.coerce.number().int().min(1).max(settings.dashboard.max_page_size),
  id: z.uuid(),
  search: z.string().max(200),
  category: z.union([z.literal(""), z.enum(families)]),
  outcome: z.enum([
    "",
    "assigned",
    "needs_review",
    "reviewed",
    "waiting",
    "skipped",
    "deferred",
  ]),
});
export const taskResultsRead = apiProcess<
  z.infer<typeof resultQuery>,
  unknown,
  AppServices
>({
  name: "tasks.results",
  auth: authorize,
  validate: validateWith(resultQuery),
  async handle(ctx, input) {
    const query = resultQuery.parse(input);
    const result = await ctx.services.taskResults.taskResults(query);
    return result ? value(result) : notFound("Categorization task not found");
  },
});
export const taskStart = apiProcess<TaskCommand, unknown, AppServices>({
  name: "tasks.start",
  auth: authorize,
  validate: validateWith(taskCommandSchema),
  handle: (ctx, i) =>
    response(ctx, async () => {
      const task = await ctx.services.tasks.createTask(
        i,
        settings.auth.username,
      );
      if (task.state === "queued") await publishReviewedTask(ctx, task.id);
      return task;
    }),
});
const control = z
  .object({
    id: z.uuid(),
    action: z.enum(["pause", "resume", "retry_failed", "retry_deferred"]),
    revision: z.number().int().positive(),
    adopt_import_limits: z.boolean().optional(),
    retry_stores: z.array(z.enum(retailerIds)).min(1).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.action === "retry_failed" && !input.retry_stores?.length)
      ctx.addIssue({
        code: "custom",
        path: ["retry_stores"],
        message: "Review the stores whose failed work should be retried.",
      });
    if (input.action !== "retry_failed" && input.retry_stores)
      ctx.addIssue({
        code: "custom",
        path: ["retry_stores"],
        message: "Store selection applies only to Retry failed.",
      });
  });
export const taskControl = apiProcess<
  z.infer<typeof control>,
  unknown,
  AppServices
>({
  name: "tasks.control",
  auth: authorize,
  validate: validateWith(control),
  handle: (ctx, i) =>
    response(ctx, async () => {
      const result = await ctx.services.tasks.controlTask(
        i.id,
        i.action,
        i.revision,
        settings.auth.username,
        i.adopt_import_limits,
        i.retry_stores,
      );
      if (
        i.action === "resume" ||
        i.action === "retry_failed" ||
        i.action === "retry_deferred"
      )
        await publishReviewedTask(ctx, i.id);
      return result;
    }),
});
const schedule = z.object({ cron: z.string().min(1) });
export const taskSchedule = apiProcess<
  z.infer<typeof schedule>,
  unknown,
  AppServices
>({
  name: "tasks.schedulePreview",
  auth: authorize,
  validate: validateWith(schedule),
  async handle(ctx, i) {
    try {
      return value({
        next_runs: ctx.services.taskSettings.nextOccurrences(
          i.cron,
          new Date(),
        ),
      });
    } catch {
      return fail("Enter a valid five-field cron expression.");
    }
  },
});
const categoryScope = z.object({ retailer: z.string(), source_id: z.string() });
export const taskCategories = apiProcess<
  z.infer<typeof categoryScope>,
  unknown,
  AppServices
>({
  name: "tasks.categoryCounts",
  auth: authorize,
  validate: validateWith(categoryScope),
  async handle(ctx, i) {
    return value(
      await ctx.services.tasks.categoryCounts(i.retailer, i.source_id),
    );
  },
});
