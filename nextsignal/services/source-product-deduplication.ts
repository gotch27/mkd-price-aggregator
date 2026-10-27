import { aggregateAvailabilitySql } from "./product-availability";
import type { PoolClient } from "pg";
import { pool, transaction } from "@/nextsignal/services/database";
import { storeProductKey } from "@/nextsignal/domain/source-product-identity";
import {
  refreshIdentitySafety,
  refreshSourcePrices,
} from "./matching-repository";
import { logEvent } from "@/nextsignal/adapters/log-context";

type Options = { after: string | null; limit: number; apply: boolean };
async function requirePaused(c: PoolClient) {
  await c.query(
    "SELECT pg_advisory_xact_lock(hashtext('store-product-group-commit'))",
  );
  const row = (
    await c.query(
      "SELECT policy->>'paused' AS paused FROM operational_settings WHERE id FOR SHARE",
    )
  ).rows[0];
  if (row?.paused !== "true")
    throw new Error(
      "Pause all work before combining existing duplicate products",
    );
}
function validateLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Specify a batch size between 1 and 1000");
}

// Deliberate local maintenance, never an import, matching run, or AI request.
// The raw identity_base is required: a colon in a genuine article code is not
// evidence of an occurrence suffix. All original observations/history survive.
export async function deduplicateProductBatch(options: Options) {
  validateLimit(options.limit);
  const rows = (
    await pool.query<{
      id: string;
      retailer: string;
      fingerprint: string;
      base: string;
    }>(
      `SELECT sp.id,sp.retailer,sp.fingerprint,original.base FROM store_products sp
      JOIN LATERAL (SELECT l.raw->>'identity_base' AS base FROM store_product_aliases a
        JOIN listings l ON l.id=a.listing_id WHERE a.store_product_id=sp.id AND l.raw ? 'identity_base'
        ORDER BY a.listing_id LIMIT 1) original ON true
      WHERE NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id)
        AND NOT sp.duplicate_conflict AND sp.external_key ~ ':([2-9]|[1-9][0-9]+)$'
        AND left(sp.external_key,length(original.base)+1)=original.base||':'
        AND ($1::uuid IS NULL OR sp.id>$1) ORDER BY sp.id LIMIT $2`,
      [options.after, options.limit],
    )
  ).rows;
  const summary = {
    examined: rows.length,
    combined: 0,
    retained_for_review: 0,
    cursor: rows.at(-1)?.id ?? options.after,
    completed: rows.length < options.limit,
  };
  const reviewed = new Set<string>();
  for (const row of rows) {
    const key = storeProductKey("", row.base);
    const groupKey = `${row.retailer}:${key}:${row.fingerprint}`;
    if (reviewed.has(groupKey)) continue;
    reviewed.add(groupKey);
    const outcome = await transaction(async (c) => {
      if (options.apply) await requirePaused(c);
      const members = (
        await c.query<{
          id: string;
          external_key: string;
          group_id: string;
          protected: boolean;
        }>(
          `SELECT sp.*, (sp.manual_facts<>'{}'::jsonb OR sp.manual_family IS NOT NULL OR sp.state='matched'
        OR EXISTS(SELECT 1 FROM product_category_edits e WHERE e.store_product_id=sp.id)
        OR EXISTS(SELECT 1 FROM manual_product_links m WHERE m.a_id=sp.id OR m.b_id=sp.id)
        OR EXISTS(SELECT 1 FROM product_detail_edits e WHERE e.store_product_id=sp.id)
        OR EXISTS(SELECT 1 FROM store_match_decisions d WHERE d.store_product_id=sp.id AND d.outcome='matched')
        OR EXISTS(SELECT 1 FROM store_products other WHERE other.group_id=sp.group_id AND other.id<>sp.id)
        OR EXISTS(SELECT 1 FROM task_items ti JOIN task_executions t ON t.id=ti.task_id
          WHERE ti.store_product_id=sp.id AND t.state IN ('queued','running','paused'))) AS protected
        FROM store_products sp WHERE sp.retailer=$1 AND sp.fingerprint=$2
          AND (sp.external_key=$3 OR (left(sp.external_key,length($4)+1)=$4||':' AND sp.external_key ~ ':[0-9]+$'
            AND EXISTS(SELECT 1 FROM store_product_aliases a JOIN listings l ON l.id=a.listing_id WHERE a.store_product_id=sp.id AND l.raw->>'identity_base'=$4)))
          AND NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id)
        ORDER BY sp.id FOR UPDATE OF sp`,
          [row.retailer, row.fingerprint, key, row.base],
        )
      ).rows;
      if (!members.some((m) => m.id === row.id)) return "unchanged";
      if (members.filter((m) => m.protected).length > 1) {
        if (options.apply)
          await c.query(
            `UPDATE store_products SET duplicate_conflict=true,ambiguous=true,
          last_reason='Repeated source rows have separate saved decisions or human edits; review before combining',version=version+1 WHERE id=ANY($1::uuid[])`,
            [members.map((m) => m.id)],
          );
        return "review";
      }
      const canonical =
        members.find((m) => m.protected) ??
        members.find((m) => m.external_key === key) ??
        members[0];
      const retired = members.filter((m) => m.id !== canonical.id);
      if (!options.apply) return retired.length ? retired.length : "unchanged";
      for (const old of retired) {
        await c.query(
          `INSERT INTO store_product_deduplications(canonical_id,retired_id,previous_record)
          SELECT $2,id,to_jsonb(sp) FROM store_products sp WHERE id=$1 ON CONFLICT DO NOTHING`,
          [old.id, canonical.id],
        );
        await c.query(
          `INSERT INTO store_product_redirects(from_id,to_id,original_fingerprint,reason)
          VALUES($1,$2,$3,'Identical published product details repeated under occurrence identifiers') ON CONFLICT DO NOTHING`,
          [old.id, canonical.id, row.fingerprint],
        );
        await c.query(
          `INSERT INTO store_product_observations(listing_id,store_product_id,previous_group_id)
          SELECT listing_id,$2,$3 FROM store_product_aliases WHERE store_product_id=$1 ON CONFLICT DO NOTHING`,
          [old.id, canonical.id, old.group_id],
        );
        await c.query(
          "UPDATE store_product_aliases SET store_product_id=$2 WHERE store_product_id=$1",
          [old.id, canonical.id],
        );
        await c.query(
          "DELETE FROM store_product_sources WHERE store_product_id=$1",
          [old.id],
        );
        await c.query(
          `UPDATE store_products SET external_key='deduplicated:'||id::text,category_pending=false,rules_pending=false,ai_pending=false,
          branch_conflict=false,version=version+1,last_reason='Repeated source entry combined; original record and history preserved' WHERE id=$1`,
          [old.id],
        );
        await c.query(
          `UPDATE matching_work SET state='completed',token=NULL,lease_until=NULL,reason='Repeated source entry combined without AI',updated_at=now() WHERE store_product_id=$1`,
          [old.id],
        );
        if (old.group_id !== canonical.group_id)
          await c.query(
            `UPDATE products SET redirect_id=$2,matching_version=matching_version+1 WHERE id=$1
          AND redirect_id IS NULL AND NOT EXISTS(SELECT 1 FROM store_products sp WHERE sp.group_id=$1 AND NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id))`,
            [old.group_id, canonical.group_id],
          );
      }
      await c.query("UPDATE store_products SET external_key=$2 WHERE id=$1", [
        canonical.id,
        key,
      ]);
      // Rebuild this product's compact branch summaries; prices remain correct
      // between maintenance batches. Current offers are never rewritten/deleted.
      await c.query(
        `INSERT INTO store_product_sources(store_product_id,source_id,price,highest_price,offer_count,retrieved_at,duplicate_count,price_conflict,available)
        SELECT a.store_product_id,o.source_id,min(o.price),max(o.price),count(*)::int,max(o.retrieved_at),
          (count(*)-count(DISTINCT jsonb_build_array(o.price,o.regular_price,o.promo_price,o.unit_price,o.available,o.promotion)))::int,count(DISTINCT o.price)>1,${aggregateAvailabilitySql}
        FROM store_product_aliases a JOIN offers o ON o.listing_id=a.listing_id AND o.source_id=a.source_id WHERE a.store_product_id=$1 GROUP BY a.store_product_id,o.source_id
        ON CONFLICT(store_product_id,source_id) DO UPDATE SET price=excluded.price,highest_price=excluded.highest_price,offer_count=excluded.offer_count,retrieved_at=excluded.retrieved_at,duplicate_count=excluded.duplicate_count,price_conflict=excluded.price_conflict,available=excluded.available`,
        [canonical.id],
      );
      await refreshIdentitySafety(c, [canonical.id]);
      await c.query(
        "UPDATE catalog_browser_state SET requested_at=clock_timestamp() WHERE key='catalog'",
      );
      return retired.length || "unchanged";
    });
    if (outcome === "review") summary.retained_for_review++;
    else if (typeof outcome === "number") summary.combined += outcome;
  }
  await logEvent(
    summary.retained_for_review ? "warn" : "info",
    "catalog.duplicates.repaired",
    options.apply
      ? "Existing repeated product entries combined; source prices and history preserved"
      : "Duplicate product repair dry run completed",
    { ...summary, applied: options.apply },
  );
  return summary;
}

export async function refreshDuplicatePricesBatch(options: Options) {
  validateLimit(options.limit);
  const rows = (
    await pool.query<{ id: string }>(
      `SELECT id FROM sources WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`,
      [options.after, options.limit],
    )
  ).rows;
  let duplicates = 0,
    conflicts = 0;
  for (const { id } of rows) {
    if (options.apply) {
      const counts = await transaction(async (c) => {
        await requirePaused(c);
        return refreshSourcePrices(c, id);
      });
      duplicates += counts.identical_duplicate_rows;
      conflicts += counts.price_conflicts;
    } else {
      const counts = (
        await pool.query(
          `SELECT count(*)::int AS observations FROM offers WHERE source_id=$1`,
          [id],
        )
      ).rows[0];
      if (!counts) throw new Error("Catalog count unavailable");
    }
  }
  const summary = {
    catalogs: rows.length,
    identical_duplicate_rows: duplicates,
    price_conflicts: conflicts,
    cursor: rows.at(-1)?.id ?? options.after,
    completed: rows.length < options.limit,
  };
  await logEvent(
    "info",
    "catalog.duplicates.prices_refreshed",
    "Duplicate and conflicting price summaries checked",
    { ...summary, applied: options.apply },
  );
  return summary;
}
