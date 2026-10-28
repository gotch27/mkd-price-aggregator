import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import { families } from "@/nextsignal/domain/matching";

export const operationModes = ["off", "manual", "automatic"] as const;
export const taskKinds = [
  "discover",
  "import",
  "categorize",
  "llm_review",
  "match",
] as const;
export const retailerIds = [
  "kam",
  "ramstore",
  "stokomak",
  "spar",
  "zito",
  "vero",
  "zur",
  "dim",
  "reptil",
] as const;
const labels = z
  .array(z.enum(families))
  .refine(
    (a) => new Set(a).size === a.length,
    "Choose each category only once",
  );
const money = z.number().finite().nonnegative();
export const operationalSchema = z
  .strictObject({
    paused: z.boolean(),
    imports: z.enum(operationModes),
    categorization: z.enum(operationModes),
    matching: z.enum(operationModes),
    ai_enabled: z.boolean(),
    clarification_enabled: z.boolean(),
    cron: z.string().refine((expression) => {
      try {
        if (expression.trim().split(/\s+/).length !== 5) return false;
        CronExpressionParser.parse(expression, { tz: "Europe/Skopje" });
        return true;
      } catch {
        return false;
      }
    }, "Enter a valid five-field cron expression"),
    scheduled_stores: z
      .array(z.enum(retailerIds))
      .refine((a) => new Set(a).size === a.length),
    catch_up: z.boolean(),
    ai_categories: labels,
    category_threshold: z.number().min(0).max(1),
    match_threshold: z.number().min(0).max(1),
    initial_budget_usd: money,
    monthly_budget_usd: money,
    task_budget_usd: money,
    task_request_limit: z.number().int().min(1).max(100000),
    default_product_limit: z.number().int().min(1).max(100000),
    candidate_limit: z.number().int().min(1).max(20),
    candidate_batch_size: z.number().int().min(1).max(5),
    batch_size: z.number().int().min(1).max(50),
    parallel_imports: z.number().int().min(1).max(9),
    per_store_downloads: z.number().int().min(1).max(9),
  })
  .refine(
    (p) => p.candidate_batch_size <= p.candidate_limit,
    "Candidate batch cannot exceed the candidate limit",
  );
export type OperationalPolicy = z.infer<typeof operationalSchema>;
export type OperationEpochs = {
  imports: number;
  categorization: number;
  matching: number;
  ai: number;
};
export type SavedTaskSettings = {
  revision: number;
  policy: OperationalPolicy;
  epochs: OperationEpochs;
  updated_at: string;
  updated_by: string;
  category_backlog_active: boolean;
};
export const taskCommandSchema = z
  .strictObject({
    revision: z.number().int().positive(),
    kind: z.enum(taskKinds),
    retailers: z
      .array(z.enum(retailerIds))
      .min(1)
      .refine((a) => new Set(a).size === a.length),
    source_id: z.uuid().nullable(),
    product_limit: z.number().int().min(1).max(100000).nullable(),
    use_ai: z.boolean(),
    categories: labels,
    max_cost_usd: money,
    recheck: z.boolean(),
    idempotency_key: z.uuid(),
  })
  .superRefine((v, ctx) => {
    if (["categorize", "llm_review"].includes(v.kind) && !v.use_ai)
      ctx.addIssue({
        code: "custom",
        path: ["use_ai"],
        message: "Categorization uses AI",
      });
    if (!["categorize", "llm_review", "match"].includes(v.kind) && v.use_ai)
      ctx.addIssue({
        code: "custom",
        path: ["use_ai"],
        message: "This task does not use AI",
      });
    if (v.kind === "match" && v.use_ai && !v.categories.length)
      ctx.addIssue({
        code: "custom",
        path: ["categories"],
        message: "Choose categories for AI matching",
      });
  });
export type TaskCommand = z.infer<typeof taskCommandSchema>;
export type TaskKind = (typeof taskKinds)[number];
export type TaskExecution = {
  id: string;
  kind: TaskKind;
  origin: "manual" | "scheduled" | "automatic";
  state: "queued" | "running" | "paused" | "completed" | "failed" | "cooldown";
  retry_at: string | null;
  manual_authorized: boolean;
  policy: OperationalPolicy;
  epochs: OperationEpochs;
  settings_revision: number;
  options: TaskCommand;
  checkpoint: Record<string, unknown>;
  reason: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  campaign_id: string | null;
  selected: number;
  processed: number;
  connected: number;
  unresolved: number;
};
export type TaskSettingsView = SavedTaskSettings & {
  gateway_recovery: { initial_seconds: number; maximum_seconds: number };
  worker_limits: {
    max_downloads: number;
    parallel_publications: number;
    ready_catalogs: number;
  };
  models: { decision: string; clarification: string };
  key_ready: boolean;
  worker_online: boolean;
  stores: { slug: string; name: string; enabled: boolean }[];
  categories: { id: string; name: string; count: number }[];
  next_runs: string[];
  timezone: string;
  spending: {
    initial_usd: string;
    monthly_usd: string;
    initial_remaining_usd: number;
    monthly_remaining_usd: number;
  };
};
export class TaskPaused extends Error {}
export class GatewayCoolingDown extends TaskPaused {
  constructor(public readonly retryAt: string) {
    super(
      "AI service is cooling down. Pending work will retry automatically when allowed.",
    );
  }
}
export class TaskConflict extends Error {}
export function operationFor(kind: TaskKind) {
  return kind === "categorize" || kind === "llm_review"
    ? "categorization"
    : kind === "match"
      ? "matching"
      : "imports";
}
