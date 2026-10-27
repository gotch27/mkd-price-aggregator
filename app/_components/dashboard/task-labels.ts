import type { TaskKind } from "@/nextsignal/domain/task-settings";
export const taskLabels: Record<TaskKind, string> = {
  discover: "Discover catalogs",
  import: "Import prices",
  categorize: "Categorize products",
  match: "Run matching",
};
export const operation = (kind: TaskKind) =>
  kind === "categorize"
    ? "categorization"
    : kind === "match"
      ? "matching"
      : "imports";

export const taskSettingLabels: Record<string, string> = {
  paused: "Pause all work",
  imports: "Price imports",
  categorization: "Categorization",
  categorization_backlog: "Existing categorization backlog",
  matching: "Matching",
  ai_enabled: "AI permission",
  clarification_enabled: "Qwen clarification",
  cron: "Import schedule",
  scheduled_stores: "Scheduled stores",
  catch_up: "Catch-up imports",
  ai_categories: "Automatic AI categories",
  category_threshold: "Category probability",
  match_threshold: "Same-product probability",
  initial_budget_usd: "Initial allowance",
  monthly_budget_usd: "Monthly allowance",
  task_budget_usd: "Per-task allowance",
  task_request_limit: "Requests per task",
  default_product_limit: "Products per task",
  candidate_limit: "Candidate groups",
  candidate_batch_size: "Candidates per request",
  batch_size: "Products per batch",
  parallel_imports: "Parallel imports",
};
export const settingValue = (field: string, value: unknown): string => {
  if (field.endsWith("_threshold")) return `${Number(value) * 100}%`;
  if (field.endsWith("_usd")) return `$${Number(value).toFixed(2)}`;
  if (Array.isArray(value))
    return value.length
      ? value.map((v) => String(v).replaceAll("_", " ")).join(", ")
      : "None";
  return value === true
    ? "On"
    : value === false
      ? "Off"
      : value === "manual"
        ? "Manual only"
        : String(value).replaceAll("_", " ");
};
