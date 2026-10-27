import { aggregateAvailabilitySql } from "./product-availability";
import { hash } from "@/nextsignal/domain/normalize";
import {
  inputFingerprint,
  type StoreProduct,
} from "@/nextsignal/domain/matching";
import { pool, transaction } from "@/nextsignal/services/database";
import { refreshIdentitySafety } from "@/nextsignal/services/matching-repository";
import { logEvent } from "@/nextsignal/adapters/log-context";

// Explicit maintenance only: this never starts imports, matching, or AI work.
// Old IDs and all immutable observations/decisions/edits remain available.
export async function repairIdentityBatch(options: {
  after: string | null;
  limit: number;
  apply: boolean;
}) {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 1000
  )
    throw new Error("Repair batch size must be between 1 and 1000 products");
  const rows = (
    await pool.query<StoreProduct>(
      `SELECT sp.* FROM store_products sp WHERE sp.ambiguous
      AND NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id)
      AND ($1::uuid IS NULL OR sp.id>$1) ORDER BY sp.id LIMIT $2`,
      [options.after, options.limit],
    )
  ).rows;
  const summary = {
    examined: rows.length,
    canonicalized: 0,
    consolidated: 0,
    skipped: 0,
    cursor: rows.at(-1)?.id ?? options.after,
    completed: rows.length < options.limit,
  };
  for (const row of rows) {
    if (row.fingerprint === inputFingerprint(row)) continue;
    const outcome = await transaction(async (c) => {
      // Same lock as human/group commits. Applying also requires a global pause;
      // a settings change or another maintainer cannot race a correction.
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtext('store-product-group-commit'))",
      );
      if (options.apply) {
        const state = (
          await c.query(
            "SELECT policy->>'paused' AS paused FROM operational_settings WHERE id=true FOR SHARE",
          )
        ).rows[0];
        if (state?.paused !== "true")
          throw new Error(
            "Pause all work before applying the product identity repair",
          );
      }
      const twins = (
        await c.query<StoreProduct & { protected: boolean }>(
          `SELECT sp.*, (sp.manual_facts<>'{}'::jsonb OR sp.manual_family IS NOT NULL OR sp.state='matched'
          OR EXISTS(SELECT 1 FROM product_category_edits e WHERE e.store_product_id=sp.id)
          OR EXISTS(SELECT 1 FROM manual_product_links m WHERE m.a_id=sp.id OR m.b_id=sp.id)
          OR EXISTS(SELECT 1 FROM product_detail_edits e WHERE e.store_product_id=sp.id)
          OR EXISTS(SELECT 1 FROM store_match_decisions d WHERE d.store_product_id=sp.id AND d.outcome='matched')
          OR EXISTS(SELECT 1 FROM store_products other WHERE other.group_id=sp.group_id AND other.retailer<>sp.retailer)
          OR EXISTS(SELECT 1 FROM task_items ti JOIN task_executions task ON task.id=ti.task_id
            WHERE ti.store_product_id=sp.id AND task.state IN ('queued','running','paused'))) AS protected
        FROM store_products sp WHERE sp.retailer=$1 AND sp.external_key=$2
          AND NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id)
        ORDER BY sp.id FOR UPDATE OF sp`,
          [row.retailer, row.external_key],
        )
      ).rows.filter((p) => inputFingerprint(p) === inputFingerprint(row));
      if (
        !twins.some(
          (p) => p.id === row.id && p.fingerprint !== inputFingerprint(p),
        )
      )
        return "unchanged";
      if (twins.filter((p) => p.protected).length > 1) return "skipped";
      const canonical =
        twins.find((p) => p.protected) ??
        twins.find((p) => p.fingerprint === inputFingerprint(p)) ??
        twins[0];
      const retired = twins.filter((p) => p.id !== canonical.id);
      if (!options.apply)
        return retired.length ? "consolidated" : "canonicalized";
      for (const old of retired) {
        await c.query(
          `INSERT INTO store_product_redirects(from_id,to_id,original_fingerprint,reason)
            VALUES($1,$2,$3,'Duplicate reliability flag incorrectly created a descriptive revision')`,
          [old.id, canonical.id, old.fingerprint],
        );
        // Free the canonical fingerprint while keeping the old row and its audit references.
        await c.query(
          `UPDATE store_products SET fingerprint=$2,branch_conflict=false,
          category_pending=false,rules_pending=false,ai_pending=false,version=version+1,
          last_reason='Historical duplicate revision; current observations use the preserved canonical product',updated_at=now() WHERE id=$1`,
          [
            old.id,
            hash({ preserved_revision: old.id, fingerprint: old.fingerprint }),
          ],
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
          `UPDATE matching_work SET state='completed',token=NULL,lease_until=NULL,
          reason='Historical duplicate revision consolidated without new matching work',updated_at=now() WHERE store_product_id=$1`,
          [old.id],
        );
      }
      await c.query(
        "UPDATE store_products SET fingerprint=$2,version=version+1,updated_at=now() WHERE id=$1",
        [canonical.id, inputFingerprint(canonical)],
      );
      await c.query(
        "DELETE FROM store_product_sources WHERE store_product_id=$1",
        [canonical.id],
      );
      await c.query(
        `INSERT INTO store_product_sources(store_product_id,source_id,price,highest_price,offer_count,retrieved_at,available)
        SELECT a.store_product_id,o.source_id,min(o.price),max(o.price),count(*)::int,max(o.retrieved_at),${aggregateAvailabilitySql}
        FROM store_product_aliases a JOIN offers o ON o.listing_id=a.listing_id AND o.source_id=a.source_id
        WHERE a.store_product_id=$1 GROUP BY a.store_product_id,o.source_id`,
        [canonical.id],
      );
      await refreshIdentitySafety(c, [
        canonical.id,
        ...retired.map((p) => p.id),
      ]);
      return retired.length ? "consolidated" : "canonicalized";
    });
    if (outcome !== "unchanged") summary[outcome]++;
  }
  await logEvent(
    summary.skipped ? "warn" : "info",
    "matching.identity_repair.batch",
    options.apply
      ? "Product identity repair batch saved; existing decisions and edits preserved"
      : "Product identity repair dry run completed",
    { ...summary, applied: options.apply },
  );
  return summary;
}
