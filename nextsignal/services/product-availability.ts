import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import { pool, transaction, withLock } from "./database";
import { taskContext } from "./task-context";
import { logEvent } from "@/nextsignal/adapters/log-context";
import type { ProductAvailability } from "@/nextsignal/domain/availability";
import { parseKam } from "./parsers";

// Callers supply code-owned aliases/placeholders, never request text.
export const availableIdentitySql = (
  id: string,
  scope?: string,
) => `EXISTS(SELECT 1 FROM store_product_sources available_source JOIN sources available_catalog ON available_catalog.id=available_source.source_id AND available_catalog.active
 WHERE available_source.store_product_id=${id} AND available_source.available IS TRUE AND available_catalog.availability_indexed_at IS NOT NULL${scope ? ` AND (${scope}::uuid IS NULL OR available_source.source_id=${scope}::uuid)` : ""})`;
export const availableProductSql = (alias: string, scope?: string) =>
  availableIdentitySql(`${alias}.id`, scope);
export const aggregateAvailabilitySql = `CASE WHEN bool_or(o.available IS TRUE) THEN true WHEN bool_and(o.available IS FALSE) THEN false ELSE NULL END`;
export function availabilitySql(id: string, scope?: string) {
  return scope
    ? `coalesce((SELECT CASE WHEN ss.available IS TRUE AND s.availability_indexed_at IS NOT NULL THEN 'available' WHEN ss.available IS NULL OR s.availability_indexed_at IS NULL THEN 'unknown' ELSE 'unavailable' END FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active WHERE ss.store_product_id=${id} AND ss.source_id=${scope}),'unknown')`
    : `coalesce((SELECT availability FROM store_product_availability WHERE store_product_id=${id}),'unknown')`;
}
export async function availabilityMap(
  ids: string[],
  c: Pick<PoolClient, "query"> = pool,
) {
  const rows = (
    await c.query<{
      store_product_id: string;
      availability: ProductAvailability;
    }>(
      `SELECT * FROM store_product_availability WHERE store_product_id=ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  return new Map(rows.map((r) => [r.store_product_id, r.availability]));
}
export class ProductUnavailable extends Error {
  constructor(
    readonly state: ProductAvailability,
    readonly productId: string,
  ) {
    super(
      state === "unavailable"
        ? "Skipped: product is marked unavailable in every selected catalog"
        : state === "not_listed"
          ? "Skipped: product is no longer listed in the selected catalogs"
          : "Skipped: product availability is not confirmed",
    );
  }
}
type Guard = { ids: string[]; primary: string };
const guard = new AsyncLocalStorage<Guard>();
export function withAvailableProducts<T>(
  ids: string[],
  primary: string,
  work: () => Promise<T>,
) {
  const previous = guard.getStore();
  return guard.run(
    {
      ids: [...new Set([...(previous?.ids ?? []), ...ids])],
      primary: previous?.primary ?? primary,
    },
    work,
  );
}
export async function assertProductAvailable(
  id: string,
  sourceId: string | null = null,
  c: Pick<PoolClient, "query"> = pool,
) {
  const row = sourceId
    ? (
        await c.query<{ availability: ProductAvailability }>(
          `SELECT CASE WHEN available IS TRUE AND s.availability_indexed_at IS NOT NULL THEN 'available' WHEN available IS NULL OR s.availability_indexed_at IS NULL THEN 'unknown' ELSE 'unavailable' END availability FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active WHERE ss.store_product_id=$1 AND ss.source_id=$2`,
          [id, sourceId],
        )
      ).rows[0]
    : (
        await c.query<{ availability: ProductAvailability }>(
          `SELECT availability FROM store_product_availability WHERE store_product_id=$1`,
          [id],
        )
      ).rows[0];
  if (row?.availability !== "available")
    throw new ProductUnavailable(row?.availability ?? "not_listed", id);
}
export async function assertAvailableContext() {
  const current = guard.getStore();
  if (!current) return;
  for (const id of current.ids)
    await assertProductAvailable(
      id,
      id === current.primary
        ? (taskContext()?.task.options.source_id ?? null)
        : null,
    );
}

// Deliberate local repair only: one source transaction at a time, resumable via
// availability_indexed_at. It reads saved offers and never grants automation.
export async function repairSourceAvailability(sourceId: string) {
  const result = await withLock(`availability-source:${sourceId}`, () =>
    transaction(async (c) => {
      const source = (
        await c.query(
          `SELECT id,retailer,name FROM sources WHERE id=$1 AND availability_indexed_at IS NULL FOR UPDATE`,
          [sourceId],
        )
      ).rows[0];
      if (!source) return null;
      let corrected = 0;
      if (
        source.retailer === "kam" &&
        (
          await c.query(
            "SELECT 1 FROM offers WHERE source_id=$1 AND available IS NULL LIMIT 1",
            [sourceId],
          )
        ).rowCount
      ) {
        const artifact = (
          await c.query("SELECT content FROM artifacts WHERE source_id=$1", [
            sourceId,
          ])
        ).rows[0]?.content;
        if (artifact) {
          const corrections = parseKam(artifact)
            .filter((r) => r.available !== null)
            .map((r) => ({ lines: r.raw.lines, available: r.available }));
          corrected =
            (
              await c.query(
                `UPDATE offers o SET available=r.available FROM listings l JOIN jsonb_to_recordset($2::jsonb) AS r(lines jsonb,available boolean) ON l.raw->'lines'=r.lines
             WHERE o.source_id=$1 AND o.listing_id=l.id AND o.available IS NULL`,
                [sourceId, JSON.stringify(corrections)],
              )
            ).rowCount ?? 0;
        }
      }
      const updated = await c.query(
        `WITH source_values AS(SELECT a.store_product_id,o.source_id,${aggregateAvailabilitySql} available FROM offers o JOIN store_product_aliases a ON a.listing_id=o.listing_id AND a.source_id=o.source_id WHERE o.source_id=$1 GROUP BY a.store_product_id,o.source_id)
    UPDATE store_product_sources ss SET available=v.available FROM source_values v WHERE ss.store_product_id=v.store_product_id AND ss.source_id=v.source_id`,
        [sourceId],
      );
      await c.query(
        "UPDATE sources SET availability_indexed_at=clock_timestamp() WHERE id=$1",
        [sourceId],
      );
      await c.query(
        "INSERT INTO dashboard_refresh_events(transaction_id) VALUES(txid_current()) ON CONFLICT DO NOTHING",
      );
      return {
        source_id: sourceId,
        retailer: source.retailer,
        products: updated.rowCount,
        source_rows_corrected: corrected,
      };
    }),
  );
  if (result)
    await logEvent(
      "debug",
      "catalog.availability.repaired",
      "Saved catalog availability indexed without external requests",
      result,
    );
  return result;
}
