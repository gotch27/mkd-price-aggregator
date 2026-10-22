import {
  businessProcess,
  ok,
  value,
  type ProcessContext,
} from "@gotch/nextsignal";
import { settings } from "@/nextsignal/config";
import { CatalogRestartRequired } from "@/nextsignal/domain/types";
import type { AppServices } from "@/nextsignal/services";

// Every retailer has a named process, while the importers own source protocols.
export const retailerProcesses = Object.keys(settings.sources).map((retailer) =>
  businessProcess<{ run_id: string }, unknown, AppServices>({
    name: `catalog.${retailer}.retrieve`,
    auth: () => ok(),
    validate: () => ok(),
    handle: (ctx, input) => retrieveRetailer(ctx, input.run_id, retailer),
  }),
);

async function retrieveRetailer(
  ctx: ProcessContext<AppServices>,
  runId: string,
  retailer: string,
) {
  const run = await ctx.services.runs.getRun(runId);
  if (run.retailer !== retailer || !run.source_id)
    throw new Error("Retailer run mismatch");
  if (await ctx.services.runs.supersedeObsolete(run))
    return value({ status: "superseded" });
  const source = await ctx.services.catalog.getSource(run.source_id);
  if (typeof run.checkpoint.source_url !== "string")
    throw new CatalogRestartRequired(
      "Legacy catalog run has no source URL; create a fresh run",
    );
  source.url = run.checkpoint.source_url;
  if (
    run.checkpoint.page_size !== undefined &&
    run.checkpoint.page_size !== settings.sources[retailer].page_size
  )
    throw new CatalogRestartRequired(
      "Configured page size changed; start a fresh catalog run",
    );
  const policy = settings.sources[retailer].identity_policy;
  const previousPolicy =
    run.checkpoint.identity_policy ??
    (run.checkpoint.cursor || run.checkpoint.done
      ? Object.keys(run.checkpoint.key_counts ?? {}).length > 0
        ? "occurrence"
        : "strict"
      : policy);
  if (previousPolicy !== policy)
    throw new CatalogRestartRequired(
      "Configured identity policy changed; start a fresh catalog run",
    );
  run.checkpoint.page_size = settings.sources[retailer].page_size;
  run.checkpoint.identity_policy = policy;
  if (run.checkpoint.done !== true)
    for await (const page of ctx.services.importers.retrieve(
      source,
      typeof run.checkpoint.cursor === "string" ? run.checkpoint.cursor : null,
    )) {
      await ctx.services.catalog.stagePage(run, page);
      await ctx.logger.info({
        message: "Catalog page staged",
        process: ctx.metadata.processName,
        correlationId: ctx.metadata.correlationId,
        data: {
          run_id: run.id,
          retailer,
          source_id: source.id,
          count: page.rows.length,
          next: page.next,
        },
      });
    }
  return value(await ctx.services.catalog.publishCatalog(run));
}
