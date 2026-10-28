import { readCatalog, rulesFromCatalog } from "./brand-catalog";
import { settings } from "@/nextsignal/config";
import { pool, withLock } from "./database";
import { logEvent } from "@/nextsignal/adapters/log-context";
import { hash, normalizeName } from "@/nextsignal/domain/normalize";
import {
  readableProductText,
  PRODUCT_TEXT_VERSION,
} from "@/nextsignal/domain/product-text";
import {
  refreshProductFacts,
  type StoreProduct,
} from "@/nextsignal/domain/matching";

// Only derived, chain-deduplicated search/fact fields are rebuilt. Source names,
// fingerprints, revisions, prices, groups, categories and decisions stay intact.
export async function refreshProductTextIndex() {
  return withLock("store-product-readable-text", async () => {
    const progress = { scanned: 0, updated: 0, stale: 0 };
    await logEvent(
      "info",
      "products.text_index.started",
      "Readable product search update started",
      { version: PRODUCT_TEXT_VERSION },
    );
    let after = "00000000-0000-0000-0000-000000000000";
    try {
      for (;;) {
        const rows = (
          await pool.query<StoreProduct>(
            "SELECT *,version::int AS version FROM store_products WHERE id>$1 ORDER BY id LIMIT $2",
            [after, settings.maintenance.batch_size],
          )
        ).rows;
        if (!rows.length) break;
        const catalog = await readCatalog(pool);
        const changes = rows.flatMap((row) => {
          const next = refreshProductFacts(
            row,
            rulesFromCatalog(catalog, row.retailer),
            settings.matching.category_mappings,
          );
          const name = normalizeName(
            readableProductText(row.name, row.retailer),
          );
          return name !== row.normalized_name ||
            hash(next.facts) !== hash(row.facts) ||
            next.family !== row.family ||
            next.local_key !== row.local_key
            ? [
                {
                  id: row.id,
                  version: row.version,
                  fingerprint: row.fingerprint,
                  normalized_name: name,
                  facts: next.facts,
                  family: next.family,
                  local_key: next.local_key,
                  old_facts: row.facts,
                  classified_family: row.classified_family,
                  manual_family: row.manual_family,
                },
              ]
            : [];
        });
        if (changes.length) {
          const updated = await pool.query(
            `UPDATE store_products sp SET normalized_name=r.normalized_name,facts=r.facts,family=r.family,local_key=r.local_key
      FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,version bigint,fingerprint text,normalized_name text,facts jsonb,family text,local_key text,old_facts jsonb,classified_family text,manual_family text)
      WHERE sp.id=r.id AND sp.version=r.version AND sp.fingerprint=r.fingerprint AND sp.facts=r.old_facts
       AND sp.classified_family IS NOT DISTINCT FROM r.classified_family AND sp.manual_family IS NOT DISTINCT FROM r.manual_family`,
            [JSON.stringify(changes)],
          );
          progress.updated += updated.rowCount ?? 0;
          progress.stale += changes.length - (updated.rowCount ?? 0);
        }
        progress.scanned += rows.length;
        after = rows.at(-1)!.id;
        await logEvent(
          "debug",
          "products.text_index.checkpoint",
          "Readable product search checkpoint saved",
          { ...progress, after, version: PRODUCT_TEXT_VERSION },
        );
      }
      await logEvent(
        "info",
        "products.text_index.completed",
        "Readable product search update completed",
        { ...progress, version: PRODUCT_TEXT_VERSION },
      );
      return progress;
    } catch (error) {
      await logEvent(
        "error",
        "products.text_index.failed",
        "Readable product search update failed",
        { ...progress, version: PRODUCT_TEXT_VERSION },
        error,
      );
      throw error;
    }
  });
}
