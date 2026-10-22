import nextEnv from "@next/env";
import {
  createConfig,
  envConfigProvider,
  jsonConfigProvider,
} from "@gotch/nextsignal";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
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
const consumers = [
  "catalog.job",
  "catalog.match",
  ...retailers.map((r) => `catalog.${r}.job`),
];
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
const cap = nullable(numeric(z.number().nonnegative()));
const cron = z.string().refine((v) => {
  try {
    if (v.trim().split(/\s+/).length !== 5) return false;
    CronExpressionParser.parse(v);
    return true;
  } catch {
    return false;
  }
}, "A valid five-field cron expression is required");
export const configSchema = object({
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
  }),
  scheduler: object({
    cron,
    tick_cron: z.literal("* * * * *"),
    run_on_start: bool,
    tick_ms: integer.refine(
      (v) => v === 60000,
      "Scheduler requires a 60000ms tick",
    ),
    catch_up: bool,
  }),
  queue: object({
    concurrency: z.record(
      z
        .string()
        .refine((key) => consumers.includes(key), "Unknown queue consumer"),
      integer,
    ),
    scheduler_concurrency: integer,
    database_pool_size: integer,
    recover_orphans: bool,
    dispatch_batch: integer,
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
    host_intervals_ms: z.record(z.string().min(1), integer),
    max_pages: integer,
    max_bytes: integer,
    user_agent: z.string().min(1),
  }),
  ingestion: object({
    invalid_price_policy: z.enum(["reject", "preserve_unknown"]),
    reduction_ratio: numeric(z.number().min(0).max(1)),
    artifact_hours: integer,
    staging_hours: integer,
    freshness_hours: integer,
  }),
  matching: object({
    enabled: bool,
    local: object({
      enabled: bool,
      version: z.string().min(1),
      index_batch_size: integer,
      brands: z.array(
        object({
          canonical: z.string().min(1),
          aliases: z.array(z.string().min(1)).min(1),
        }),
      ),
      token_aliases: z.record(
        z.string().min(1),
        z.array(z.string().min(1)).min(1),
      ),
      ignored_tokens: z.array(z.string().min(1)),
    }),
    ambiguity_batch_size: integer,
    batch_size: integer,
    candidate_limit: integer,
    candidate_similarity: numeric(z.number().min(0).max(1)),
    threshold: numeric(z.number().min(0).max(1)),
    retry_hours: integer,
    prompt_version: z.string().min(1),
    ai: object({
      enabled: bool,
      api_key: z.string().min(1),
      base_url: z.string().url(),
      model: z.string().min(1),
      extraction: bool,
      reasoning_effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
      max_output_tokens: integer,
      timeout_ms: integer,
      run_budget_usd: cap,
      monthly_budget_usd: cap,
      max_requests_per_run: integer,
      max_requests_per_month: integer,
      input_per_million: numeric(z.number().nonnegative()),
      output_per_million: numeric(z.number().nonnegative()),
    }),
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
      cron: nullable(cron),
      api_url: nullable(z.string().url()),
      catalog_api_url: nullable(z.string().url()),
      action: nullable(z.string()),
      notice: nullable(z.string()),
    }),
  ),
}).superRefine((v, ctx) => {
  const workerSlots = Object.values(v.queue.concurrency).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (v.database.pool_size < workerSlots * 2 + 3)
    ctx.addIssue({
      code: "custom",
      path: ["database", "pool_size"],
      message:
        "Pool must accommodate worker advisory locks plus transaction connections",
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
    }
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
    if (["stokomak", "zito"].includes(key) && source.page_size !== 100)
      ctx.addIssue({
        code: "custom",
        path: ["sources", key, "page_size"],
        message: "Published platform requires page size 100",
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
  if (v.matching.ai.enabled && v.matching.ai.api_key === "disabled")
    ctx.addIssue({
      code: "custom",
      path: ["matching", "ai", "api_key"],
      message: "Configure an API key before enabling AI",
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
