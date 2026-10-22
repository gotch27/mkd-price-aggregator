import {
  apiProcess,
  ok,
  value,
  authFail,
  notFound,
  validateWith,
} from "@gotch/nextsignal";
import { z } from "zod";
import type { AppServices } from "@/nextsignal/services";
import { settings } from "@/nextsignal/config";
const authorize = (
  ctx: import("@gotch/nextsignal").ProcessContext<AppServices>,
) => ctx.auth.requireUser!(ctx);
const query = z.object({
  view: z.enum([
    "summary",
    "sources",
    "products",
    "universal",
    "runs",
    "logs",
    "decisions",
  ]),
  search: z.string(),
  page: z.coerce.number().int().positive(),
  size: z.coerce
    .number()
    .int()
    .positive()
    .max(settings.dashboard.max_page_size),
  retailer: z.string().optional(),
  source_id: z.uuid().optional(),
  run_id: z.uuid().optional(),
  correlation_id: z.string().optional(),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  name_quality: z.enum(["named", "invalid", "all"]).optional(),
  match_filter: z.enum(["all", "matched", "unmatched"]).optional(),
  status: z
    .enum([
      "pending",
      "queued",
      "running",
      "success",
      "failed",
      "quarantined",
      "superseded",
    ])
    .optional(),
  kind: z.enum(["discover", "catalog", "match"]).optional(),
});
export const readOperations = apiProcess<
  z.infer<typeof query>,
  unknown,
  AppServices
>({
  name: "operations.read",
  auth: authorize,
  validate: validateWith(query),
  async handle(ctx, input) {
    return value(
      await ctx.services.operations.readDashboard(query.parse(input)),
    );
  },
});
const ingestion = z.object({
  retailer: z
    .enum([
      "kam",
      "ramstore",
      "stokomak",
      "spar",
      "zito",
      "vero",
      "zur",
      "dim",
      "reptil",
    ])
    .nullable(),
});
export const requestIngestion = apiProcess<
  z.infer<typeof ingestion>,
  unknown,
  AppServices
>({
  name: "operations.ingest",
  auth: authorize,
  validate: validateWith(ingestion),
  async handle(ctx, input) {
    return ctx.mediator.dispatch("catalog.request", input);
  },
});
export const retry = apiProcess<{ id: string }, unknown, AppServices>({
  name: "operations.retry",
  auth: authorize,
  validate: validateWith(z.object({ id: z.uuid() })),
  async handle(ctx, input) {
    return value(await ctx.services.operations.retryRun(input.id));
  },
});
export const matchingRetry = apiProcess<
  { source_id: string | null },
  unknown,
  AppServices
>({
  name: "operations.match",
  auth: authorize,
  validate: validateWith(z.object({ source_id: z.uuid().nullable() })),
  async handle(ctx, input) {
    return value(await ctx.services.operations.retryMatching(input.source_id));
  },
});
export const login = apiProcess<
  { username: string; password: string },
  unknown,
  AppServices
>({
  name: "auth.login",
  auth: () => ok(),
  validate: validateWith(
    z.object({ username: z.string(), password: z.string() }),
  ),
  async handle(ctx, i) {
    const token = await ctx.services.operations.login(i.username, i.password);
    return token
      ? value({ token })
      : authFail("Invalid credentials or login limit reached");
  },
});
export const productOffers = apiProcess<{ id: string }, unknown, AppServices>({
  name: "products.offers",
  auth: authorize,
  validate: validateWith(z.object({ id: z.uuid() })),
  async handle(ctx, i) {
    return value(await ctx.services.operations.offersForProduct(i.id));
  },
});
export const productDetails = apiProcess<{ id: string }, unknown, AppServices>({
  name: "products.details",
  auth: authorize,
  validate: validateWith(z.object({ id: z.uuid() })),
  async handle(ctx, input) {
    const detail = await ctx.services.operations.detailsForProduct(input.id);
    return detail ? value(detail) : notFound("Product not found");
  },
});
export const health = apiProcess<void, { status: string }, AppServices>({
  name: "health.check",
  auth: () => ok(),
  validate: () => ok(),
  async handle(ctx) {
    await ctx.services.operations.checkHealth();
    return value({ status: "ok" });
  },
});
