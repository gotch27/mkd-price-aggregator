import {
  apiProcess,
  validateWith,
  value,
  notFound,
  fail,
} from "@gotch/nextsignal";
import { z } from "zod";
import type { AppServices } from "@/nextsignal/services";
import { families } from "@/nextsignal/domain/matching";
import { settings } from "@/nextsignal/config";
const authorize = (
  ctx: import("@gotch/nextsignal").ProcessContext<AppServices>,
) => ctx.auth.requireUser!(ctx);
const reviewSchema = z.strictObject({
  status: z.enum(["needs_review", "assigned", "reviewed", "agent", "all"]),
  retailer: z
    .enum([
      "kam",
      "spar",
      "dim",
      "zur",
      "vero",
      "reptil",
      "ramstore",
      "zito",
      "stokomak",
    ])
    .optional(),
  search: z.string().max(settings.product_details.value_max_length),
  availability: z.enum(["available", "all"]),
  page: z.coerce.number().int().positive(),
  size: z.coerce
    .number()
    .int()
    .positive()
    .max(settings.dashboard.max_page_size),
});
export const categoryReview = apiProcess<
  z.infer<typeof reviewSchema>,
  unknown,
  AppServices
>({
  name: "products.reviewCategories",
  auth: authorize,
  validate: validateWith(reviewSchema),
  handle: (ctx, input) =>
    ctx.services.withLogContext(
      {
        logger: ctx.logger,
        process: ctx.metadata.processName,
        correlationId: ctx.metadata.correlationId,
      },
      async () => value(await ctx.services.categoryReview.readQueue(input)),
    ),
});
const readSchema = z.strictObject({ id: z.uuid(), member_id: z.uuid() });
const saveSchema = readSchema
  .extend({
    snapshot: z.string().length(64),
    action: z.enum(["set", "accept_suggestion", "reset"]),
    category: z.enum(families).nullable(),
    note: z.string().max(settings.product_details.note_max_length),
  })
  .refine(
    (i) => (i.action === "set" ? i.category !== null : i.category === null),
    "Choose a category for a manual change; approval and reset use the saved model result.",
  );
export const readProductCategory = apiProcess<
  z.infer<typeof readSchema>,
  unknown,
  AppServices
>({
  name: "products.readCategory",
  auth: authorize,
  validate: validateWith(readSchema),
  async handle(ctx, input) {
    const result = await ctx.services.productCategories.readCategory(
      input.id,
      input.member_id,
    );
    return result ? value(result) : notFound("Store product not found");
  },
});
export const saveProductCategory = apiProcess<
  z.infer<typeof saveSchema>,
  unknown,
  AppServices
>({
  name: "products.saveCategory",
  auth: authorize,
  validate: validateWith(saveSchema),
  handle: (ctx, input) =>
    ctx.services.withLogContext(
      {
        logger: ctx.logger,
        process: ctx.metadata.processName,
        correlationId: ctx.metadata.correlationId,
      },
      async () => {
        const result = await ctx.services.productCategories.saveCategory(
          input,
          settings.auth.username,
        );
        return result.ok ? value(result) : fail(result.reason);
      },
    ),
});
