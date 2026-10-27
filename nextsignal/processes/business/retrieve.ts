import {
  businessProcess,
  ok,
  fail,
  value,
  type ProcessContext,
} from "@gotch/nextsignal";
import { TaskPaused } from "@/nextsignal/domain/task-settings";
import { settings } from "@/nextsignal/config";
import { CatalogRestartRequired, SourceError } from "@/nextsignal/domain/types";
import type { AppServices } from "@/nextsignal/services";

// Every retailer has a named process, while the importers own source protocols.
export const retailerProcesses = Object.keys(settings.sources).map((retailer) =>
  businessProcess<{ run_id: string }, unknown, AppServices>({
    name: `catalog.${retailer}.retrieve`,
    auth: () => ok(),
    validate: () => ok(),
    async handle(ctx, input) {
      try {
        return await retrieveRetailer(ctx, input.run_id, retailer);
      } catch (error) {
        if (error instanceof TaskPaused || error instanceof SourceError)
          return fail({
            message: error.message,
            code:
              error instanceof TaskPaused
                ? "task_paused"
                : "source_unavailable",
            details: error,
          });
        throw error;
      }
    },
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
  // A cursor is meaningful only with its original page size. Deployment
  // defaults affect new snapshots; resumable snapshots retain their own size.
  const pageSize =
    run.checkpoint.page_size === undefined
      ? settings.sources[retailer].page_size
      : Number(run.checkpoint.page_size);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1)
    throw new SourceError("Invalid saved catalog page size", false);
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
  run.checkpoint.page_size = pageSize;
  run.checkpoint.identity_policy = policy;
  if (run.checkpoint.done === true)
    return value(await ctx.services.catalog.publishCatalog(run));
  let pages = 0;
  const turnStarted = Date.now();
  if (run.checkpoint.done !== true)
    for await (const page of ctx.services.importers.retrieve(
      source,
      typeof run.checkpoint.cursor === "string" ? run.checkpoint.cursor : null,
      pageSize,
    )) {
      await ctx.services.checkpoint();
      const stagingStarted = performance.now();
      await ctx.services.catalog.stagePage(run, page);
      const stagingMs = Math.round(performance.now() - stagingStarted);
      pages++;
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
          staging_ms: stagingMs,
        },
      });
      if (
        page.next !== null &&
        (pages >= settings.ingestion.pages_per_turn ||
          Date.now() - turnStarted >= settings.ingestion.turn_duration_ms)
      )
        return value(await ctx.services.runs.yieldRun(run.id));
    }
  return value(await ctx.services.runs.readyForPublication(run.id));
}
