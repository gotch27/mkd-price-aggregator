import { apiProcess, validateWith, value, fail } from "@gotch/nextsignal";
import { z } from "zod";
import { settings } from "@/nextsignal/config";
import type { AppServices } from "@/nextsignal/services";
import { BrandReviewConflict } from "@/nextsignal/domain/brand-review";
import { retailerIds } from "@/nextsignal/domain/task-settings";
import { logEvent } from "@/nextsignal/adapters/log-context";
const text = z
  .string()
  .trim()
  .min(1)
  .max(settings.product_details.value_max_length);
const id = z.strictObject({ id: z.uuid() });
const start = z.strictObject({
  request_id: z.uuid(),
  limit: z.number().int().positive().max(settings.brand_review.max_groups),
  retailer: z.enum(retailerIds).optional(),
  search: z.string().max(settings.product_details.value_max_length),
  reviewer: z.enum(["human", "agent"]),
  agent_name: z.string().max(settings.product_details.value_max_length),
  agent_model: z.string().max(settings.product_details.value_max_length),
  include_previously_skipped: z.boolean(),
});
const decision = z
  .strictObject({
    item_id: z.uuid(),
    snapshot: z.string().length(64),
    action: z.enum(["save", "skip"]),
    brand_id: z.uuid().nullable(),
    brand_revision: z.number().int().positive().nullable(),
    name: text.nullable(),
    aliases: z
      .array(
        z.strictObject({
          name: text,
          retailer: z.enum(retailerIds).nullable(),
          evidence: z
            .array(
              z.strictObject({
                member_id: z.uuid(),
                field: z.enum(["name", "description"]),
                quote: text,
              }),
            )
            .min(1)
            .max(settings.brand_review.examples_per_group),
        }),
      )
      .max(settings.brand_review.examples_per_group),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(settings.product_details.note_max_length),
  })
  .refine(
    (v) =>
      v.action === "skip"
        ? v.brand_id === null && v.name === null && v.aliases.length === 0
        : v.aliases.length > 0 &&
          (v.brand_id !== null ? v.brand_revision !== null : v.name !== null),
    "Choose a brand and supported aliases, or skip without a brand",
  );
const submit = id.extend({
  request_id: z.uuid(),
  reviewer: z.enum(["human", "agent"]),
  decisions: z
    .array(decision)
    .min(1)
    .max(settings.brand_review.batch_size)
    .refine(
      (v) => new Set(v.map((d) => d.item_id)).size === v.length,
      "Submit each group once",
    ),
});
function operation<S extends z.ZodType>(
  name: string,
  schema: S,
  run: (s: AppServices, i: z.output<S>, actor: string) => Promise<unknown>,
) {
  return apiProcess<z.output<S>, unknown, AppServices>({
    name,
    auth: (ctx) => ctx.auth.requireUser!(ctx),
    validate: validateWith(schema),
    handle: (ctx, i) =>
      ctx.services.withLogContext(
        {
          logger: ctx.logger,
          process: ctx.metadata.processName,
          correlationId: ctx.metadata.correlationId,
        },
        async () => {
          try {
            return value(await run(ctx.services, i, settings.auth.username));
          } catch (error) {
            if (error instanceof BrandReviewConflict) {
              await logEvent(
                "warn",
                "brands.review.rejected",
                "Brand review request rejected",
                { reason: error.message },
              );
              return fail(error.message);
            }
            throw error;
          }
        },
      ),
  });
}
export const brandReviewContext = operation(
  "brands.reviewContext",
  z.strictObject({}),
  (s, _i, a) => s.brandReview.readContext(a),
);
export const brandReviewStart = operation(
  "brands.startReview",
  start,
  (s, i, a) => s.brandReview.startSession(i, a),
);
export const brandReviewRead = operation("brands.readReview", id, (s, i, a) =>
  s.brandReview.readSession(i.id, a),
);
export const brandReviewBatch = operation("brands.reviewBatch", id, (s, i, a) =>
  s.brandReview.readBatch(i.id, a),
);
export const brandReviewSubmit = operation(
  "brands.submitReview",
  submit,
  (s, i, a) => s.brandReview.submitBatch(i, a),
);
export const brandReviewUndo = operation(
  "brands.undoReview",
  id.extend({ reviewer: z.enum(["human", "agent"]) }),
  (s, i, a) => s.brandReview.control(i.id, a, "undo", i.reviewer),
);
export const brandReviewStop = operation("brands.stopReview", id, (s, i, a) =>
  s.brandReview.control(i.id, a, "stop"),
);
export const brandReviewAcknowledge = operation(
  "brands.acknowledgeReview",
  id,
  (s, i, a) => s.brandReview.control(i.id, a, "acknowledge"),
);
