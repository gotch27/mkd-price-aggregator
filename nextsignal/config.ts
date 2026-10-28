import nextEnv from "@next/env";
import {
  createConfig,
  envConfigProvider,
  jsonConfigProvider,
} from "@gotch/nextsignal";
import { z } from "zod";
import { families } from "@/nextsignal/domain/matching";
import { operationalSchema } from "@/nextsignal/domain/task-settings";
nextEnv.loadEnvConfig(process.cwd());
const object = <S extends z.ZodRawShape>(shape: S) => z.strictObject(shape);
const retailers = [
  "kam",
  "ramstore",
  "stokomak",
  "spar",
  "zito",
  "vero",
  "zur",
  "dim",
  "reptil",
];
const consumers = ["catalog.download", "catalog.publish", "tasks.job"];
const numeric = (schema: z.ZodNumber) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() !== "" ? Number(value) : value,
    schema,
  );
const integer = numeric(z.number().int().positive());
const nullable = <S extends z.ZodType>(schema: S) =>
  z.preprocess((value) => (value === "null" ? null : value), schema.nullable());
const bool = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((v) => v === true || v === "true");
export const configSchema = object({
  maintenance: object({ batch_size: integer }),
  tasks: object({
    defaults: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      operationalSchema,
    ),
  }),
  llm_review: object({
    instructions_file: z.string().min(1),
    max_output_tokens: integer,
    reasoning_enabled: bool,
  }),
  agent_review: object({
    default_products: integer,
    max_products: integer,
    batch_size: integer,
    results_page_size: integer,
    refresh_ms: integer,
    instructions_file: z.string().min(1),
  }).refine(
    (v) =>
      v.batch_size <= v.max_products && v.default_products <= v.max_products,
    "Agent review limits are inconsistent",
  ),
  product_details: z.preprocess(
    (v) => (typeof v === "string" ? JSON.parse(v) : v),
    object({
      value_max_length: integer,
      note_max_length: integer,
      history_limit: integer,
    }),
  ),
  app: object({
    name: z.string().min(1),
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }),
  }),
  database: object({
    url: z
      .string()
      .url()
      .refine(
        (value) =>
          ["postgres:", "postgresql:"].includes(new URL(value).protocol),
        "PostgreSQL connection URL required",
      ),
    pool_size: integer,
    connection_timeout_ms: integer,
    idle_timeout_ms: integer,
  }),
  auth: object({
    username: z.string().min(1),
    allowed_origins: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.array(z.string().url()).min(1),
    ),
    password: z.string().min(16),
    session_secret: z.string().min(32),
    session_hours: integer,
    secure_cookie: bool,
    login_window_ms: integer,
    login_attempts: integer,
    login_client_header: z.string().regex(/^[a-z][a-z0-9-]*$/),
  }),
  scheduler: object({
    tick_cron: z.literal("* * * * *"),
    run_on_start: bool,
    tick_ms: integer.refine(
      (v) => v === 60000,
      "Scheduler requires a 60000ms tick",
    ),
  }),
  queue: object({
    concurrency: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.record(
        z
          .string()
          .refine((key) => consumers.includes(key), "Unknown queue consumer"),
        integer,
      ),
    ),
    scheduler_concurrency: integer,
    database_pool_size: integer,
    dispatch_batch: integer,
    dispatch_lease_seconds: integer,
    retry_backoff: bool,
    heartbeat_seconds: integer,
    heartbeat_refresh_seconds: integer,
    stop_ms: integer,
    poll_seconds: numeric(z.number().min(0.5)),
    retry_limit: integer,
    retry_delay_seconds: integer,
    expire_seconds: integer,
    retention_seconds: integer,
  }),
  http: object({
    timeout_ms: integer,
    connect_timeout_ms: integer,
    response_idle_timeout_ms: integer,
    host_timeout_ms: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z.record(z.string().min(1), integer),
    ),
    cooldown: object({
      failure_threshold: integer,
      base_ms: integer,
      max_ms: integer,
    }),
    host_intervals_ms: z.record(z.string().min(1), integer),
    max_pages: integer,
    max_bytes: integer,
    user_agent: z.string().min(1),
  }),
  ingestion: object({
    parallel_publications: numeric(z.number().int().min(1).max(1)),
    max_ready_catalogs: integer,
    pages_per_turn: integer,
    turn_duration_ms: integer,
    invalid_price_policy: z.enum(["reject", "preserve_unknown"]),
    reduction_ratio: numeric(z.number().min(0).max(1)),
    artifact_hours: integer,
    staging_hours: integer,
    freshness_hours: integer,
  }),
  matching: object({
    ai_categories: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      z
        .array(z.enum(families))
        .refine(
          (items) => new Set(items).size === items.length,
          "Categories must be unique",
        ),
    ),
    prompts: z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      object({
        root: z.string().min(1),
        classification: z.string().min(1),
        comparison: z.string().min(1),
        comparison_question: z.string().min(1),
        clarification: z.string().min(1),
        categories: z.string().min(1),
        comparison_answers: z.string().min(1),
        stores: z.record(z.string(), z.string().min(1)),
        families: z.record(z.string(), z.string().min(1)),
      }),
    ),
    manual: object({
      candidate_limit: integer,
      group_member_limit: integer,
      search_min_length: integer,
      max_note_length: integer,
    }),
    evaluation: object({ sample_per_store: integer, holdout_divisor: integer }),
    candidate_batch_size: integer,
    category_threshold: numeric(z.number().min(0).max(1)),
    lease_seconds: integer,
    rules_version: z.string().min(1),
    category_mappings_version: z.string().min(1),
    category_mappings: z.array(
      object({
        retailer: z.enum(retailers as [string, ...string[]]),
        pattern: z
          .string()
          .min(1)
          .refine((v) => {
            try {
              new RegExp(v, "iu");
              return true;
            } catch {
              return false;
            }
          }),
        family: z.string().min(1),
      }),
    ),
    gateway: object({
      enabled: bool,
      api_key: z.string().min(1),
      base_url: z.string().url(),
      decision_endpoint: z.literal("evaluate"),
      extraction_endpoint: z.literal("chat/completions"),
      decision_model: z.string().min(1),
      extraction_model: z.string().min(1),
      decision_input_per_million: numeric(z.number().nonnegative()),
      decision_output_per_million: numeric(z.number().nonnegative()),
      extraction_input_per_million: numeric(z.number().nonnegative()),
      extraction_output_per_million: numeric(z.number().nonnegative()),
      initial_budget_usd: numeric(z.number().nonnegative()),
      monthly_budget_usd: numeric(z.number().nonnegative()),
      evaluation_budget_usd: numeric(z.number().nonnegative()),
      timeout_ms: integer,
      retry_attempts: numeric(z.number().int().min(1).max(5)),
      retry_delay_ms: integer,
      retry_max_delay_ms: integer,
      consecutive_failure_limit: integer,
      cooldown_initial_seconds: integer,
      cooldown_max_seconds: integer,
      cooldown_probe_lease_seconds: integer,
      max_input_bytes: integer,
      token_overhead_allowance: integer,
      max_output_tokens: integer,
      max_requests_per_campaign: integer,
      max_requests_per_month: integer,
      reasoning_enabled: bool,
    }),
    local: object({
      enabled: bool,
      version: z.string().min(1),
    }),
    batch_size: integer,
    candidate_limit: integer,
    candidate_weights: object({
      barcode: numeric(z.number().nonnegative()),
      signature: numeric(z.number().nonnegative()),
      brand: numeric(z.number().nonnegative()),
      quantity: numeric(z.number().nonnegative()),
      category: numeric(z.number().nonnegative()),
    }),
    candidate_similarity: numeric(z.number().min(0).max(1)),
    threshold: numeric(z.number().min(0).max(1)),
    prompt_version: z.string().min(1),
  }),
  logging: object({
    level: z.enum(["debug", "info", "warn", "error"]),
    spool_dir: z.string().min(1),
    operational_days: integer,
    debug_days: integer,
    replay_batch: integer,
  }),
  worker: object({
    heartbeat_max_age_ms: integer,
    heartbeat_file: z.string().min(1),
  }),
  dashboard: object({
    stats_refresh_ms: integer,
    page_size: integer,
    max_page_size: integer,
    refresh_ms: integer,
    search_debounce_ms: integer,
    summary_cache_ms: integer,
    auto_refresh_views: z.array(
      z.enum([
        "summary",
        "sources",
        "products",
        "universal",
        "runs",
        "logs",
        "decisions",
      ]),
    ),
    product_name_quality: z.enum(["named", "invalid", "all"]),
    product_availability: z.enum([
      "available",
      "unavailable",
      "unknown",
      "all",
    ]),
  }),
  sources: z.record(
    z.string().refine((key) => retailers.includes(key), "Unknown retailer"),
    object({
      enabled: bool,
      identity_policy: z.enum(["strict", "occurrence"]),
      timestamp_policy: z.enum(["snapshot", "observed"]),
      page_size: integer,
      name: z.string().min(1),
      url: z.string().url(),
      api_url: nullable(z.string().url()),
      catalog_api_url: nullable(z.string().url()),
      action: nullable(z.string()),
      notice: nullable(z.string()),
    }),
  ),
}).superRefine((v, ctx) => {
  if (v.matching.gateway.enabled && v.matching.gateway.api_key === "disabled")
    ctx.addIssue({
      code: "custom",
      path: ["matching", "gateway", "api_key"],
      message: "Configure the Gateway key before enabling paid matching",
    });
  for (const retailer of retailers)
    if (!v.matching.prompts.stores[retailer])
      ctx.addIssue({
        code: "custom",
        path: ["matching", "prompts", "stores", retailer],
        message: "Store naming guide required",
      });
  for (const family of families)
    if (!v.matching.prompts.families[family])
      ctx.addIssue({
        code: "custom",
        path: ["matching", "prompts", "families", family],
        message: "Category comparison prompt required",
      });
  if (v.matching.candidate_batch_size > v.matching.candidate_limit)
    ctx.addIssue({
      code: "custom",
      path: ["matching", "candidate_batch_size"],
      message: "Candidate batch cannot exceed candidate limit",
    });
  const importSlots =
    (v.queue.concurrency["catalog.download"] ?? 0) +
    (v.queue.concurrency["catalog.publish"] ?? 0);
  const taskSlots = v.queue.concurrency["tasks.job"] ?? 0;
  if (v.database.pool_size < importSlots * 4 + taskSlots * 2 + 3)
    ctx.addIssue({
      code: "custom",
      path: ["database", "pool_size"],
      message:
        "Pool must accommodate download/publication locks, transactions, and task connections",
    });
  for (const topic of consumers)
    if (v.queue.concurrency[topic] === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["queue", "concurrency", topic],
        message: "Consumer concurrency is required",
      });
  for (const source of Object.values(v.sources))
    for (const url of [source.url, source.api_url, source.catalog_api_url]) {
      if (url === null) continue;
      const host = new URL(url).host;
      if (v.http.host_intervals_ms[host] === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["http", "host_intervals_ms", host],
          message:
            "An explicit request interval is required for every source host",
        });
      if (v.http.host_timeout_ms[host] === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["http", "host_timeout_ms", host],
          message:
            "An explicit download timeout is required for every source host",
        });
    }
  if (v.http.cooldown.base_ms > v.http.cooldown.max_ms)
    ctx.addIssue({
      code: "custom",
      path: ["http", "cooldown", "max_ms"],
      message: "Maximum cooldown must cover its base delay",
    });
  if (v.queue.dispatch_lease_seconds >= v.queue.expire_seconds)
    ctx.addIssue({
      code: "custom",
      path: ["queue", "dispatch_lease_seconds"],
      message: "Dispatch recovery must happen before a queue execution expires",
    });
  for (const [key, source] of Object.entries(v.sources)) {
    const requireValue = (field: "api_url" | "catalog_api_url" | "action") => {
      if (!source[field])
        ctx.addIssue({
          code: "custom",
          path: ["sources", key, field],
          message: "Required by this source parser",
        });
    };
    if (["kam", "spar", "zur", "dim", "reptil"].includes(key))
      requireValue("api_url");
    if (["zur", "dim"].includes(key)) requireValue("action");
    if (key === "reptil") requireValue("catalog_api_url");
    if (
      ["stokomak", "zito"].includes(key) &&
      ![10, 20, 50, 100].includes(source.page_size)
    )
      ctx.addIssue({
        code: "custom",
        path: ["sources", key, "page_size"],
        message: "Published platform supports page sizes 10, 20, 50 and 100",
      });
    if (
      (key === "spar" && source.page_size > 500) ||
      (key === "reptil" && source.page_size > 100)
    )
      ctx.addIssue({
        code: "custom",
        path: ["sources", key, "page_size"],
        message: "Page size exceeds the public API limit",
      });
  }
  for (const key of [
    "kam",
    "ramstore",
    "stokomak",
    "spar",
    "zito",
    "vero",
    "zur",
    "reptil",
    "dim",
  ])
    if (!v.sources[key])
      ctx.addIssue({
        code: "custom",
        path: ["sources", key],
        message: "Source configuration is required",
      });
});
export const config = createConfig({
  providers: [
    jsonConfigProvider("config/default.json"),
    envConfigProvider({ prefix: "NEXTSIGNAL_" }),
  ],
  schema: configSchema,
});
await config.load();
export const settings = configSchema.parse(config.snapshot());
export type Settings = z.infer<typeof configSchema>;
