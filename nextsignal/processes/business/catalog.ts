import {
  businessProcess,
  ok,
  value,
  type ProcessContext,
} from "@gotch/nextsignal";
import { settings } from "@/nextsignal/config";
import {
  SourceError,
  CatalogRestartRequired,
  type Retailer,
  type Run,
} from "@/nextsignal/domain/types";
import type { AppServices } from "@/nextsignal/services";

type Context = ProcessContext<AppServices>;
type RunInput = { run_id: string };

export const executeRun = businessProcess<RunInput, unknown, AppServices>({
  name: "catalog.execute",
  auth: () => ok(),
  validate: () => ok(),
  handle: execute,
});

export const enqueueRun = businessProcess<
  { retailer: Retailer | null },
  unknown,
  AppServices
>({
  name: "catalog.request",
  auth: () => ok(),
  validate: () => ok(),
  async handle(ctx, input) {
    return value(
      await ctx.services.operations.requestIngestion(input.retailer),
    );
  },
});

async function execute(ctx: Context, input: RunInput) {
  const result = await ctx.services.withLock(`run:${input.run_id}`, () =>
    executeLocked(ctx, input.run_id),
  );
  if (result !== null) return result;

  await ctx.logger.debug?.({
    message: "Duplicate delivery acknowledged while run is active",
    data: { run_id: input.run_id },
  });
  return ok();
}

async function executeLocked(ctx: Context, runId: string) {
  const run = await ctx.services.runs.getRun(runId);
  if (["success", "quarantined", "superseded"].includes(run.status))
    return ok();
  if (
    (run.retailer && !settings.sources[run.retailer].enabled) ||
    (run.kind === "match" && !settings.matching.enabled)
  ) {
    await ctx.services.runs.supersedeDisabled(run.id);
    return ok();
  }

  const started = Date.now();
  await ctx.services.runs.startRun(run.id);
  const data = {
    run_id: run.id,
    retailer: run.retailer,
    source_id: run.source_id,
    attempt: run.attempts + 1,
  };
  await ctx.logger.info({
    message: "Run started",
    process: ctx.metadata.processName,
    correlationId: ctx.metadata.correlationId,
    data,
  });
  try {
    const summary = await performRun(ctx, run);
    await ctx.logger.info({
      message: "Run completed",
      process: ctx.metadata.processName,
      correlationId: ctx.metadata.correlationId,
      data: { ...data, ...summary, duration_ms: Date.now() - started },
    });
    return ok();
  } catch (error) {
    return handleFailure(ctx, run, error, {
      ...data,
      duration_ms: Date.now() - started,
    });
  }
}

async function performRun(ctx: Context, run: Run) {
  switch (run.kind) {
    case "discover": {
      if (!run.retailer) throw new Error("Missing retailer");
      const sources = await ctx.services.importers.discover(run.retailer);
      await ctx.services.catalog.saveDiscovery(run, sources);
      return {};
    }
    case "catalog":
      await retrieveCatalog(ctx, run);
      return {};
    case "match":
      return matchProducts(ctx, run);
  }
}

async function retrieveCatalog(ctx: Context, run: Run) {
  const result = await ctx.services.withLock(`source:${run.source_id}`, () =>
    ctx.mediator.dispatch(`catalog.${run.retailer}.retrieve`, {
      run_id: run.id,
    }),
  );
  if (result === null)
    throw new SourceError("Another worker is retrieving this source", true);
  if (result.ok) return;

  // Preserve source fault types across mediator envelopes so snapshot recovery
  // and durable retry policy can distinguish permanent and retryable failures.
  if (result.errors[0]?.details instanceof SourceError)
    throw result.errors[0].details;
  throw new SourceError(
    result.errors[0]?.message ?? "Catalog retrieval failed",
    result.meta.kind === "system",
  );
}

async function matchProducts(ctx: Context, run: Run) {
  const summary = await ctx.services.withLock("matching", () =>
    ctx.services.matching.matchBatch(run.id, run.source_id),
  );
  if (summary === null)
    throw new SourceError("Another matcher is active", true);

  await ctx.services.runs.completeRun(run.id, summary);
  if (summary.more)
    await ctx.services.runs.createRun(
      "match",
      run.retailer,
      run.source_id,
      run.parent_id ?? run.id,
    );
  return summary;
}

async function handleFailure(
  ctx: Context,
  run: Run,
  error: unknown,
  data: Record<string, unknown>,
) {
  if (error instanceof CatalogRestartRequired) {
    const next = await ctx.services.runs.restartCatalog(run, error.message);
    if (next) {
      if (next.status === "superseded") {
        await ctx.logger.info({ message: "Obsolete catalog skipped", data });
        return value({ superseded: true });
      }
      await ctx.logger.warn({
        message: "Catalog changed; fresh snapshot queued",
        process: ctx.metadata.processName,
        correlationId: ctx.metadata.correlationId,
        data: {
          ...data,
          replacement_run_id: next.id,
          source_restarts: next.checkpoint.source_restarts,
        },
        error,
      });
      return value({ restarted: next.id });
    }
  }

  await ctx.services.runs.failRun(run.id, error);
  await ctx.logger.error({
    message: "Run failed",
    process: ctx.metadata.processName,
    correlationId: ctx.metadata.correlationId,
    data,
    error,
  });
  if (error instanceof SourceError && !error.retryable)
    return value({ failed: true });
  throw error;
}
