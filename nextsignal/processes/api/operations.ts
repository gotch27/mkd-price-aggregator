import {
  apiProcess,
  ok,
  value,
  authFail,
  notFound,
  validateWith,
  fail,
} from "@gotch/nextsignal";
import { z } from "zod";
import type { AppServices } from "@/nextsignal/services";
import { settings } from "@/nextsignal/config";
import { factNames } from "@/nextsignal/domain/matching";
import { loginClient } from "@/nextsignal/adapters/auth";
import type {
  ManualCommand,
  ManualSearch,
  ManualResult,
} from "@/nextsignal/domain/manual-matching";
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
  availability: z
    .enum(["available", "unavailable", "unknown", "all"])
    .optional(),
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
    return ctx.services.withLogContext(
      {
        logger: ctx.logger,
        process: ctx.metadata.processName,
        correlationId: ctx.metadata.correlationId,
      },
      async () =>
        value(await ctx.services.operations.readDashboard(query.parse(input))),
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
    return fail(
      "Use Tasks to submit a reviewed task with its settings revision.",
    );
  },
});
export const retry = apiProcess<{ id: string }, unknown, AppServices>({
  name: "operations.retry",
  auth: authorize,
  validate: validateWith(z.object({ id: z.uuid() })),
  async handle(ctx, input) {
    return fail(
      "Use Tasks to review the scope and limits before restarting a legacy update.",
    );
  },
});
export const matchingRetry = apiProcess<
  { source_id: string | null; action?: "process_pending" | "pause" | "resume" },
  unknown,
  AppServices
>({
  name: "operations.match",
  auth: authorize,
  validate: validateWith(
    z.object({
      source_id: z.uuid().nullable(),
      action: z.enum(["process_pending", "pause", "resume"]).optional(),
    }),
  ),
  async handle(ctx, input) {
    return fail("Use Tasks to submit or control an authorized matching task.");
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
    return ctx.services.withLogContext(
      {
        logger: ctx.logger,
        process: ctx.metadata.processName,
        correlationId: ctx.metadata.correlationId,
      },
      async () => {
        const result = await ctx.services.operations.login(
          i.username,
          i.password,
          loginClient(ctx.request?.headers),
        );
        if (result.status === "authenticated")
          return value({ token: result.token });
        if (result.status === "limited")
          return fail({
            code: "auth.rate_limited",
            message:
              "Too many failed sign-in attempts from this connection. Please try again shortly.",
            details: { retry_after_seconds: result.retry_after_seconds },
          });
        return authFail("Incorrect username or password.");
      },
    );
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
    const started = performance.now();
    const detail = await ctx.services.operations.detailsForProduct(input.id);
    await ctx.logger.debug?.({
      message: "Product details loaded",
      data: {
        event: "products.details.loaded",
        product_id: input.id,
        duration_ms: Math.round(performance.now() - started),
        found: detail !== null,
      },
    });
    return detail ? value(detail) : notFound("Product not found");
  },
});
const editableDetailsSchema = z.strictObject({
  id: z.uuid(),
  member_id: z.uuid(),
});
export const editableProductDetails = apiProcess<
  z.infer<typeof editableDetailsSchema>,
  unknown,
  AppServices
>({
  name: "products.editableDetails",
  auth: authorize,
  validate: validateWith(editableDetailsSchema),
  async handle(ctx, input) {
    const result = await ctx.services.productDetails.read(
      input.id,
      input.member_id,
    );
    return result ? value(result) : notFound("Store product not found");
  },
});
const updateDetailsSchema = z
  .strictObject({
    id: z.uuid(),
    member_id: z.uuid(),
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(["update", "reset"]),
    changes: z.partialRecord(
      z.enum(factNames),
      z.string().max(settings.product_details.value_max_length).nullable(),
    ),
    note: z.string().max(settings.product_details.note_max_length),
  })
  .refine(
    (input) =>
      input.action === "reset"
        ? Object.keys(input.changes).length === 0
        : Object.keys(input.changes).length > 0,
    "Choose at least one detail to update; resets must not include changes.",
  );
export const updateProductDetails = apiProcess<
  z.infer<typeof updateDetailsSchema>,
  unknown,
  AppServices
>({
  name: "products.updateDetails",
  auth: authorize,
  validate: validateWith(updateDetailsSchema),
  handle: handleProductDetailUpdate,
});
async function handleProductDetailUpdate(
  ctx: import("@gotch/nextsignal").ProcessContext<AppServices>,
  input: z.infer<typeof updateDetailsSchema>,
) {
  return ctx.services.withLogContext(
    {
      logger: ctx.logger,
      process: ctx.metadata.processName,
      correlationId: ctx.metadata.correlationId,
    },
    async () => {
      const result = await ctx.services.productDetails.save(
        input,
        settings.auth.username,
      );
      return result.ok ? value(result) : fail(result.reason);
    },
  );
}
export const health = apiProcess<void, { status: string }, AppServices>({
  name: "health.check",
  auth: () => ok(),
  validate: () => ok(),
  async handle(ctx) {
    await ctx.services.operations.checkHealth();
    return value({ status: "ok" });
  },
});

const manualSearchSchema = z.object({
  id: z.uuid(),
  page: z.coerce.number().int().positive(),
  search: z.string().max(settings.matching.manual.max_note_length),
  retailer: z
    .enum(Object.keys(settings.sources) as [string, ...string[]])
    .optional(),
});
export const manualMatchSearch = apiProcess<
  z.infer<typeof manualSearchSchema>,
  ManualSearch,
  AppServices
>({
  name: "products.manualSearch",
  auth: authorize,
  validate: validateWith(manualSearchSchema),
  async handle(ctx, input) {
    return ctx.services.withLogContext(
      {
        logger: ctx.logger,
        process: ctx.metadata.processName,
        correlationId: ctx.metadata.correlationId,
      },
      async () =>
        value(
          await ctx.services.manualMatching.search(
            input.id,
            input.search,
            input.page,
            input.retailer,
          ),
        ),
    );
  },
});
const manualCommandSchema = z.discriminatedUnion("action", [
  z.object({
    id: z.uuid(),
    action: z.literal("connect"),
    snapshot: z.string().length(64),
    candidate_id: z.uuid(),
    candidate_snapshot: z.string().length(64),
    note: z.string().max(settings.matching.manual.max_note_length),
  }),
  z.object({
    id: z.uuid(),
    action: z.literal("separate"),
    snapshot: z.string().length(64),
    member_id: z.uuid(),
    note: z.string().max(settings.matching.manual.max_note_length),
  }),
]);
export const manualMatchSave = apiProcess<
  ManualCommand,
  ManualResult,
  AppServices
>({
  name: "products.manualSave",
  auth: authorize,
  validate: validateWith(manualCommandSchema),
  async handle(ctx, input) {
    return ctx.services.withLogContext(
      {
        logger: ctx.logger,
        process: ctx.metadata.processName,
        correlationId: ctx.metadata.correlationId,
      },
      async () => {
        const result = await ctx.services.manualMatching.save(
          input,
          settings.auth.username,
        );
        return result.ok ? value(result) : fail(result.reason);
      },
    );
  },
});
