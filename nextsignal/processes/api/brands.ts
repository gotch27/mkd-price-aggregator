import { apiProcess, validateWith, value, fail, ok } from "@gotch/nextsignal";
import { z } from "zod";
import { logEvent } from "@/nextsignal/adapters/log-context";
import { settings } from "@/nextsignal/config";
import { retailerIds } from "@/nextsignal/domain/task-settings";
import { BrandConflict } from "@/nextsignal/domain/brands";
import type { AppServices } from "@/nextsignal/services";
const auth = (ctx: import("@gotch/nextsignal").ProcessContext<AppServices>) =>
  ctx.auth.requireUser!(ctx);
const input = z.strictObject({
  name: z.string().trim().min(1).max(settings.product_details.value_max_length),
  aliases: z
    .array(
      z.strictObject({
        name: z
          .string()
          .trim()
          .min(1)
          .max(settings.product_details.value_max_length),
        retailer: z.enum(retailerIds).nullable(),
      }),
    )
    .max(settings.dashboard.max_page_size),
});
const query = z.object({
  search: z.string().max(settings.product_details.value_max_length),
  page: z.coerce.number().int().positive(),
  size: z.coerce
    .number()
    .int()
    .positive()
    .max(settings.dashboard.max_page_size),
});
export const readBrands = apiProcess<
  z.infer<typeof query>,
  unknown,
  AppServices
>({
  name: "brands.list",
  auth,
  validate: validateWith(query),
  handle: async (ctx, i) =>
    value(await ctx.services.brands.list(i.search, i.page, i.size)),
});
export const readBrandOptions = apiProcess<void, unknown, AppServices>({
  name: "brands.options",
  auth,
  validate: () => ok(),
  handle: async (ctx) => value(await ctx.services.brands.options()),
});
function mutation<S extends z.ZodType>(
  name: string,
  schema: S,
  run: (s: AppServices, i: z.output<S>) => Promise<unknown>,
) {
  return apiProcess<z.output<S>, unknown, AppServices>({
    name,
    auth,
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
            return value(await run(ctx.services, i));
          } catch (e) {
            if (e instanceof BrandConflict) {
              await logEvent(
                "warn",
                "brands.change.rejected",
                "Brand change rejected",
                { actor: settings.auth.username, reason: e.message },
              );
              return fail(e.message);
            }
            throw e;
          }
        },
      ),
  });
}
export const createBrand = mutation("brands.create", input, (s, i) =>
  s.brands.save(i, settings.auth.username),
);
const edit = input.extend({
  id: z.uuid(),
  revision: z.number().int().positive(),
});
export const editBrand = mutation("brands.edit", edit, (s, i) =>
  s.brands.save(i, settings.auth.username, i.id, i.revision),
);
