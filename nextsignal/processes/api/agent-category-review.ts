import {
  apiProcess,
  validateWith,
  value,
  fail,
  systemFail,
} from "@gotch/nextsignal";
import { z } from "zod";
import type { AppServices } from "@/nextsignal/services";
import { settings } from "@/nextsignal/config";
import { families } from "@/nextsignal/domain/matching";
import { AgentReviewConflict } from "@/nextsignal/services/agent-category-review";
import { logEvent } from "@/nextsignal/adapters/log-context";

const idSchema = z.strictObject({ id: z.uuid() });
const retailers = z.enum([
  "kam",
  "spar",
  "dim",
  "zur",
  "vero",
  "reptil",
  "ramstore",
  "zito",
  "stokomak",
]);
const startSchema = z.strictObject({
  request_id: z.uuid(),
  limit: z.number().int().positive().max(settings.agent_review.max_products),
  retailer: retailers.optional(),
  search: z.string().max(settings.product_details.value_max_length),
  agent_name: z.string().max(settings.product_details.value_max_length),
  agent_model: z.string().max(settings.product_details.value_max_length),
  include_previously_skipped: z.boolean().optional(),
});
const submitSchema = idSchema.extend({
  request_id: z.uuid(),
  decisions: z
    .array(
      z
        .strictObject({
          member_id: z.uuid(),
          snapshot: z.string().length(64),
          action: z.enum(["set", "skip"]),
          category: z.enum(families).nullable(),
          reason: z
            .string()
            .trim()
            .min(1)
            .max(settings.product_details.note_max_length),
        })
        .refine(
          (v) =>
            v.action === "set"
              ? v.category !== null && v.category !== "unknown"
              : v.category === null,
          "Choose a supported category, or skip with a null category.",
        ),
    )
    .min(1)
    .max(settings.agent_review.batch_size)
    .refine(
      (v) => new Set(v.map((i) => i.member_id)).size === v.length,
      "Submit each product only once.",
    ),
});
function operation<S extends z.ZodType>(
  name: string,
  schema: S,
  run: (
    services: AppServices,
    input: z.output<S>,
    actor: string,
  ) => Promise<unknown>,
) {
  return apiProcess<z.output<S>, unknown, AppServices>({
    name,
    auth: (ctx) => ctx.auth.requireUser!(ctx),
    validate: validateWith(schema),
    handle: (ctx, input) =>
      ctx.services.withLogContext(
        {
          logger: ctx.logger,
          process: ctx.metadata.processName,
          correlationId: ctx.metadata.correlationId,
        },
        async () => {
          try {
            return value(
              await run(ctx.services, input, settings.auth.username),
            );
          } catch (error) {
            if (error instanceof AgentReviewConflict) {
              await logEvent(
                "warn",
                "products.agent_review.rejected",
                "Agent category review request was not accepted",
                { process: name, reason: error.message },
              );
              return fail(error.message);
            }
            await logEvent(
              "error",
              "products.agent_review.failed",
              "Agent category review request failed",
              { process: name },
              error,
            );
            return systemFail(
              error instanceof Error
                ? error
                : new Error("Agent category review failed"),
            );
          }
        },
      ),
  });
}
export const agentCategoryContext = operation(
  "products.agentCategoryContext",
  z.strictObject({}),
  (s, _i, a) => s.agentCategoryReview.readContext(a),
);
export const startAgentCategoryReview = operation(
  "products.startAgentCategoryReview",
  startSchema,
  (s, i, a) => s.agentCategoryReview.startSession(i, a),
);
export const readAgentCategoryReview = operation(
  "products.readAgentCategoryReview",
  idSchema,
  (s, i, a) => s.agentCategoryReview.readSession(i.id, a),
);
export const readAgentCategoryBatch = operation(
  "products.readAgentCategoryBatch",
  idSchema,
  (s, i, a) => s.agentCategoryReview.readBatch(i.id, a),
);
export const submitAgentCategoryBatch = operation(
  "products.submitAgentCategoryBatch",
  submitSchema,
  (s, i, a) => s.agentCategoryReview.submitBatch(i, a),
);
export const stopAgentCategoryReview = operation(
  "products.stopAgentCategoryReview",
  idSchema,
  (s, i, a) => s.agentCategoryReview.stopSession(i.id, a),
);
export const undoAgentCategoryBatch = operation(
  "products.undoAgentCategoryBatch",
  idSchema,
  (s, i, a) => s.agentCategoryReview.undoBatch(i.id, a),
);
export const acknowledgeAgentCategoryReview = operation(
  "products.acknowledgeAgentCategoryReview",
  idSchema,
  (s, i, a) => s.agentCategoryReview.acknowledgeSession(i.id, a),
);
