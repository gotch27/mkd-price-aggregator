import { pool, transaction, withLock } from "@/nextsignal/services/database";
import { settings } from "@/nextsignal/config";
import { localMatchingVersion } from "@/nextsignal/domain/local-matching";
import { logEvent } from "@/nextsignal/adapters/log-context";

export type ProductStatistics = {
  counts: Record<string, number>;
  retailer_counts: Record<string, number> | null;
  availability_counts: Record<
    string,
    { available: number; unavailable: number; unknown: number }
  > | null;
  matching_counts: Record<string, number>;
  work_counts: Record<string, number>;
  updated_at: Date | null;
  pending: boolean;
};

export async function readProductStatistics(): Promise<ProductStatistics> {
  const row = (
    await pool.query<ProductStatistics>(
      `SELECT counts,retailer_counts,availability_counts,matching_counts,work_counts,updated_at,
      updated_at IS NULL OR retailer_counts IS NULL OR availability_counts IS NULL OR rule_version<>$1 OR EXISTS(SELECT 1 FROM dashboard_refresh_events) AS pending
     FROM dashboard_product_snapshot WHERE id`,
      [localMatchingVersion(settings.matching.local)],
    )
  ).rows[0];
  if (!row)
    throw new Error("Dashboard statistics are not initialized; run migrations");
  return row;
}

// Local derived data only. This never starts imports, matching, or provider calls.
export async function refreshProductStatistics(force = false) {
  return withLock("dashboard-product-statistics", async () => {
    const started = performance.now();
    try {
      const previous = await readProductStatistics();
      if (
        !force &&
        (!previous.pending ||
          (previous.updated_at &&
            Date.now() - previous.updated_at.getTime() <
              settings.dashboard.stats_refresh_ms))
      )
        return false;
      await transaction(async (c) => {
        await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const events = (
          await c.query<{ id: string }>(
            "SELECT id FROM dashboard_refresh_events ORDER BY id",
          )
        ).rows;
        const result = (
          await c.query(
            `WITH active AS MATERIALIZED (
            SELECT sp.id,sp.group_id AS product_id,sp.retailer,sp.normalized_name ~ '[a-z]' AS usable_name,sp.state,sp.local_key,
              (SELECT availability FROM store_product_availability WHERE store_product_id=sp.id) AS availability
            FROM store_products sp WHERE EXISTS(
              SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active WHERE ss.store_product_id=sp.id
            )
          ), visible AS MATERIALIZED (
            SELECT a.product_id,a.retailer,a.usable_name FROM active a
            WHERE EXISTS(SELECT 1 FROM store_product_aliases alias WHERE alias.store_product_id=a.id)
            UNION ALL
            SELECT l.product_id,b.retailer,b.usable_name FROM catalog_browser b JOIN listings l ON l.id=b.listing_id
            WHERE NOT EXISTS(SELECT 1 FROM store_product_aliases alias WHERE alias.listing_id=b.listing_id)
          ), groups AS (
            SELECT product_id,count(DISTINCT retailer) stores FROM visible GROUP BY product_id
          ), product_counts AS (
            SELECT state,count(*)::int AS count FROM active GROUP BY state
          ), work_counts AS (
            SELECT w.state,count(*)::int AS count FROM matching_work w JOIN active a ON a.id=w.store_product_id GROUP BY w.state
          ) SELECT
            (SELECT count(*)::int FROM visible) AS catalog_items,
            (SELECT count(*)::int FROM active WHERE availability='available') AS available_store_products,
            (SELECT coalesce(jsonb_object_agg(retailer,totals),'{}'::jsonb) FROM(SELECT retailer,
              jsonb_build_object('available',count(*) FILTER(WHERE availability='available'),'unavailable',count(*) FILTER(WHERE availability='unavailable'),'unknown',count(*) FILTER(WHERE availability='unknown')) totals FROM active GROUP BY retailer) per_availability) AS availability_counts,
            (SELECT count(*)::int FROM visible WHERE NOT usable_name) AS unnamed,
            (SELECT count(*)::int FROM groups) AS universal_products,
            (SELECT count(*)::int FROM groups WHERE stores>1) AS cross_store_products,
            (SELECT coalesce(jsonb_object_agg(retailer,count),'{}'::jsonb) FROM
              (SELECT retailer,count(*)::int AS count FROM active GROUP BY retailer) per_retailer) AS retailer_counts,
            (SELECT count(*)::int FROM store_products WHERE state='matched') AS matched,
            (SELECT count(*)::int FROM active) AS local_indexed,
            (SELECT count(*)::int FROM active WHERE local_key IS NOT NULL) AS local_eligible,
            coalesce((SELECT jsonb_object_agg(state,count) FROM product_counts),'{}'::jsonb) AS matching_counts,
            coalesce((SELECT jsonb_object_agg(state,count) FROM work_counts),'{}'::jsonb) AS work_counts`,
          )
        ).rows[0];
        const {
          matching_counts,
          work_counts,
          retailer_counts,
          availability_counts,
          ...counts
        } = result;
        await c.query(
          `UPDATE dashboard_product_snapshot SET counts=$1,matching_counts=$2,work_counts=$3,rule_version=$4,retailer_counts=$5,availability_counts=$6,updated_at=clock_timestamp() WHERE id`,
          [
            counts,
            matching_counts,
            work_counts,
            localMatchingVersion(settings.matching.local),
            retailer_counts,
            availability_counts,
          ],
        );
        if (events.length)
          await c.query(
            "DELETE FROM dashboard_refresh_events WHERE id=ANY($1::bigint[])",
            [events.map((e) => e.id)],
          );
      });
      await logEvent(
        "info",
        "dashboard.statistics.refreshed",
        "Saved dashboard statistics updated",
        { duration_ms: Math.round(performance.now() - started) },
      );
      return true;
    } catch (error) {
      await logEvent(
        "warn",
        "dashboard.statistics.failed",
        "Statistics update failed; previous totals remain available",
        {},
        error,
      );
      return false;
    }
  });
}
