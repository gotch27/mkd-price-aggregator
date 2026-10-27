import { AsyncLocalStorage } from "node:async_hooks";
import { settings } from "@/nextsignal/config";
import {
  operationFor,
  TaskPaused,
  type TaskExecution,
  type SavedTaskSettings,
} from "@/nextsignal/domain/task-settings";
import { pool } from "./database";
import { readSettings } from "./task-settings";

const storage = new AsyncLocalStorage<{
  task: TaskExecution;
  live: SavedTaskSettings;
}>();
export const taskContext = () => storage.getStore();
export const withTaskContext = <T>(
  task: TaskExecution,
  live: SavedTaskSettings,
  fn: () => Promise<T>,
) => storage.run({ task, live }, fn);
export async function checkpoint(ai = false) {
  const context = taskContext();
  if (!context) return;
  let live: SavedTaskSettings;
  try {
    live = await readSettings();
  } catch {
    throw new TaskPaused("Waiting: task settings cannot be read");
  }
  context.live = live;
  const current = (
    await pool.query(`SELECT state FROM task_executions WHERE id=$1`, [
      context.task.id,
    ])
  ).rows[0];
  if (!current || !["queued", "running"].includes(current.state))
    throw new TaskPaused("Task is paused");
  assertPermission(context.task, live, ai);
}
export function assertPermission(
  task: TaskExecution,
  live: SavedTaskSettings,
  ai = false,
) {
  const op = operationFor(task.kind);
  if (live.policy.paused) throw new TaskPaused("All work is paused");
  if (live.policy[op] === "off") throw new TaskPaused("This operation is off");
  if (
    !task.manual_authorized &&
    (live.policy[op] !== "automatic" || task.epochs[op] !== live.epochs[op])
  )
    throw new TaskPaused(
      "Automatic permission changed; resume explicitly to continue",
    );
  if (
    ai &&
    (!task.options.use_ai ||
      !task.policy.ai_enabled ||
      !live.policy.ai_enabled ||
      (!task.manual_authorized && task.epochs.ai !== live.epochs.ai))
  )
    throw new TaskPaused("AI permission is off or changed");
}
export function matchingConfig() {
  const ctx = taskContext();
  if (!ctx) return settings.matching;
  const { task, live } = ctx,
    p = task.policy,
    l = live.policy;
  return {
    ...settings.matching,
    enabled: true,
    automatic_enabled: false,
    ai_categories: task.manual_authorized
      ? task.options.categories
      : task.options.categories.filter((category) =>
          l.ai_categories.includes(category),
        ),
    category_threshold: Math.max(p.category_threshold, l.category_threshold),
    threshold: Math.max(p.match_threshold, l.match_threshold),
    candidate_limit: Math.min(p.candidate_limit, l.candidate_limit),
    candidate_batch_size: Math.min(
      p.candidate_batch_size,
      l.candidate_batch_size,
    ),
    batch_size: Math.min(p.batch_size, l.batch_size),
    gateway: {
      ...settings.matching.gateway,
      enabled: task.options.use_ai && p.ai_enabled && l.ai_enabled,
      initial_budget_usd: Math.min(p.initial_budget_usd, l.initial_budget_usd),
      monthly_budget_usd: Math.min(p.monthly_budget_usd, l.monthly_budget_usd),
    },
  };
}
