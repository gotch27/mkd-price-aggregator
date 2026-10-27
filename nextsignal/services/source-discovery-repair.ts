import type { PoolClient } from "pg";
import { settings } from "@/nextsignal/config";
import { hash } from "@/nextsignal/domain/normalize";
import { logEvent } from "@/nextsignal/adapters/log-context";
import { pool, transaction } from "./database";
import {
  discoverRamstoreCatalogs,
  discoverSparCatalogs,
  discoverVeroCatalogs,
  discoverVeroExcludedCatalogs,
} from "./catalog-discovery";

const retailers = ["vero", "ramstore", "spar"] as const;
export type DiscoveryRepairPages = Record<(typeof retailers)[number], string>;
type SourceRow = {
  id: string;
  retailer: (typeof retailers)[number];
  external_id: string;
  name: string;
  active: boolean;
  meta: Record<string, unknown>;
};
type SourceState = Pick<SourceRow, "name" | "active" | "meta">;
export type DiscoveryRepairChange = {
  source_id: string;
  retailer: string;
  external_id: string;
  metadata_changed: boolean;
  before: SourceState;
  after: SourceState;
  skipped_run_ids: string[];
};

// A dry run reads only existing application metadata. This diagnostic transport
// deliberately does not use the import client's health ledger or create runs.
// Its three public URLs, deadlines, and byte cap come from deployment config.
export async function fetchSourceDiscoveryRepairPages(): Promise<DiscoveryRepairPages> {
  const pages = {} as DiscoveryRepairPages;
  for (const retailer of retailers) {
    const url = settings.sources[retailer].url;
    const host = new URL(url).host;
    const timeout = settings.http.host_timeout_ms[host];
    if (timeout === undefined)
      throw new Error(`Missing http.host_timeout_ms for ${host}`);
    const controller = new AbortController();
    const response = await fetch(url, {
      headers: { "user-agent": settings.http.user_agent },
      signal: AbortSignal.any([
        AbortSignal.timeout(timeout),
        controller.signal,
      ]),
    });
    const reader = response.body?.getReader();
    try {
      if (!response.ok || !reader)
        throw new Error(
          `Cannot review ${retailer} discovery: HTTP ${response.status}`,
        );
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > settings.http.max_bytes)
          throw new Error(
            `Discovery response exceeds configured byte limit: ${retailer}`,
          );
        chunks.push(Buffer.from(chunk.value));
      }
      pages[retailer] = Buffer.concat(chunks).toString("utf8");
    } finally {
      controller.abort();
      try {
        await reader?.cancel();
      } catch {
        /* Preserve the original failure. */
      }
      reader?.releaseLock();
    }
  }
  return pages;
}

export async function assertSourceDiscoveryRepairSafe(c?: PoolClient) {
  const database = c ?? pool;
  const state = (
    await database.query<{
      paused: boolean;
      worker_online: boolean;
      executing_imports: number;
    }>(
      `SELECT (policy->>'paused')::boolean AS paused,
       EXISTS(SELECT 1 FROM worker_heartbeats WHERE key='catalog' AND seen_at>now()-$1*interval '1 millisecond') AS worker_online,
       (SELECT count(*)::int FROM runs WHERE kind IN ('catalog','discover')
         AND (status='running' OR (dispatch_token IS NOT NULL AND status IN ('pending','queued')))) AS executing_imports
       FROM operational_settings WHERE id=true${c ? " FOR SHARE" : ""}`,
      [settings.worker.heartbeat_max_age_ms],
    )
  ).rows[0];
  if (!state)
    throw new Error(
      "Task settings are not initialized; refusing discovery repair",
    );
  if (state.executing_imports)
    throw new Error(
      "Wait until executing imports and dispatch reservations have stopped before applying discovery repair",
    );
  if (!state.paused && state.worker_online)
    throw new Error(
      "Pause all work, or stop the worker and wait for its heartbeat to expire, before applying discovery repair",
    );
}

function candidates(pages: DiscoveryRepairPages) {
  const accepted = {
    vero: discoverVeroCatalogs(pages.vero, settings.sources.vero.url),
    ramstore: discoverRamstoreCatalogs(
      pages.ramstore,
      settings.sources.ramstore.url,
    ),
    spar: discoverSparCatalogs(pages.spar, settings.sources.spar.url),
  };
  for (const retailer of retailers)
    if (!accepted[retailer].length)
      throw new Error(
        `No verified ${retailer} store cards were parsed; refusing discovery repair`,
      );
  const excluded = discoverVeroExcludedCatalogs(
    pages.vero,
    settings.sources.vero.url,
  );
  return {
    accepted: new Map(
      Object.values(accepted)
        .flat()
        .map((source) => [`${source.retailer}:${source.external_id}`, source]),
    ),
    excluded: new Map(
      excluded.map((source) => [`vero:${source.external_id}`, source]),
    ),
  };
}

// Explicit metadata repair only: no new source, price, product, or matching work.
export async function repairSourceDiscovery(options: {
  pages: DiscoveryRepairPages;
  apply: boolean;
  actor: string;
}) {
  if (!options.actor.trim()) throw new Error("A repair actor is required");
  const parsed = candidates(options.pages);
  const result = await transaction(async (c) => {
    if (options.apply) {
      // Prevent a dispatcher from reserving work between the safety check and
      // commit. A live worker also needs either global pause or an expired heartbeat.
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('import-dispatch',0))",
      );
      await assertSourceDiscoveryRepairSafe(c);
    }
    const rows = (
      await c.query<SourceRow>(
        `SELECT id,retailer,external_id,name,active,meta FROM sources WHERE retailer=ANY($1::text[]) ORDER BY retailer,external_id${options.apply ? " FOR UPDATE" : ""}`,
        [retailers],
      )
    ).rows;
    const changes: DiscoveryRepairChange[] = [];
    for (const row of rows) {
      const key = `${row.retailer}:${row.external_id}`;
      const excluded = parsed.excluded.get(key);
      const published = excluded ?? parsed.accepted.get(key);
      if (!published) continue;
      const before: SourceState = {
        name: row.name,
        active: row.active,
        meta: row.meta,
      };
      const after: SourceState = {
        name: published.name,
        active: excluded ? false : row.active,
        meta: { ...row.meta, ...published.meta },
      };
      const metadataChanged = hash(before) !== hash(after);
      if (metadataChanged && before.name !== after.name) {
        const previous = row.meta.discovery_name_history;
        if (previous !== undefined && !Array.isArray(previous))
          throw new Error(
            `Invalid discovery name history for source ${row.id}`,
          );
        after.meta.discovery_name_history = [
          ...(Array.isArray(previous) ? previous : []),
          {
            name: before.name,
            corrected_at: new Date().toISOString(),
            actor: options.actor,
          },
        ];
      }
      const pending = excluded
        ? (
            await c.query<{ id: string }>(
              `SELECT id FROM runs WHERE source_id=$1 AND kind='catalog' AND status IN ('pending','queued','paused') ORDER BY created_at${options.apply ? " FOR UPDATE" : ""}`,
              [row.id],
            )
          ).rows.map((run) => run.id)
        : [];
      if (!metadataChanged && !pending.length) continue;
      const change: DiscoveryRepairChange = {
        source_id: row.id,
        retailer: row.retailer,
        external_id: row.external_id,
        metadata_changed: metadataChanged,
        before,
        after,
        skipped_run_ids: pending,
      };
      changes.push(change);
      if (!options.apply) continue;
      if (metadataChanged)
        await c.query(
          "UPDATE sources SET name=$2,meta=$3,active=$4 WHERE id=$1",
          [row.id, after.name, after.meta, after.active],
        );
      if (pending.length)
        await c.query(
          `UPDATE runs SET status='superseded',finished_at=now(),error=NULL,
           dispatch_token=NULL,dispatch_until=NULL,dispatch_phase=NULL,
           summary=summary||jsonb_build_object('reason','Excluded catalog: Jumbo is not a Vero supermarket','excluded_source_id',$2::text)
           WHERE id=ANY($1::uuid[])`,
          [pending, row.id],
        );
    }
    if (options.apply && changes.length)
      await c.query(
        "UPDATE catalog_browser_state SET requested_at=clock_timestamp() WHERE key='catalog'",
      );
    return {
      applied: options.apply,
      reviewed_sources: rows.length,
      changed_sources: changes.filter((change) => change.metadata_changed)
        .length,
      deactivated_sources: changes.filter(
        (change) => change.before.active && !change.after.active,
      ).length,
      skipped_catalog_runs: changes.reduce(
        (sum, change) => sum + change.skipped_run_ids.length,
        0,
      ),
      changes,
    };
  });
  // Audit success is emitted only after the entire repair commits. Historical
  // offers/listings/groups/decisions remain intact, including excluded catalogs.
  if (options.apply) {
    for (const change of result.changes)
      await logEvent(
        "info",
        "catalog.discovery.repaired",
        "Catalog discovery metadata corrected",
        { actor: options.actor, ...change },
      );
    await logEvent(
      "info",
      "catalog.discovery_repair.completed",
      "Catalog discovery correction completed; product and price history is preserved",
      {
        actor: options.actor,
        reviewed_sources: result.reviewed_sources,
        changed_sources: result.changed_sources,
        deactivated_sources: result.deactivated_sources,
        skipped_catalog_runs: result.skipped_catalog_runs,
      },
    );
  }
  return result;
}
