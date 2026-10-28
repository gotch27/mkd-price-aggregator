import { normalizeName } from "@/nextsignal/domain/normalize";
import { settings } from "@/nextsignal/config";
import { pool, transaction, withLock } from "@/nextsignal/services/database";

type Correction = { name: string; normalized_name: string };
type Progress = {
  names: number;
  completed: number;
  listings: number;
  products: number;
};

// Rebuild derived spelling without altering published names, source identities,
// product assignments, attributes, prices, or previously saved match decisions.
export async function reindexProductNames(
  onProgress?: (progress: Progress) => void,
) {
  return withLock("catalog-browser-refresh", async () => {
    const rows = (
      await pool.query<{ name: string; normalized_name: string }>(
        "SELECT DISTINCT name,normalized_name FROM catalog_browser",
      )
    ).rows;
    const corrections = new Map<string, Correction>();
    for (const row of rows) {
      const normalized = normalizeName(row.name);
      if (normalized !== row.normalized_name)
        corrections.set(row.name, {
          name: row.name,
          normalized_name: normalized,
        });
    }
    const changes = [...corrections.values()];
    const progress: Progress = {
      names: changes.length,
      completed: 0,
      listings: 0,
      products: 0,
    };
    onProgress?.({ ...progress });
    if (!changes.length) return progress;

    // A rebuild remains marked dirty if interrupted. A retry is idempotent.
    await pool.query(
      "UPDATE catalog_browser_state SET requested_at=clock_timestamp() WHERE key='catalog'",
    );
    const size = settings.maintenance.batch_size;
    for (let offset = 0; offset < changes.length; offset += size) {
      const batch = changes.slice(offset, offset + size);
      const updated = await transaction(async (client) => {
        // Keep product and listing derived names consistent if a batch retries.
        const products = await client.query(
          `UPDATE products p SET normalized_name=r.normalized_name
           FROM jsonb_to_recordset($1::jsonb) AS r(name text,normalized_name text)
           WHERE p.name=r.name AND p.normalized_name IS DISTINCT FROM r.normalized_name`,
          [JSON.stringify(batch)],
        );
        const listings = await client.query(
          `WITH corrections AS MATERIALIZED (
            SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(name text,normalized_name text)
          ), targets AS MATERIALIZED (
            SELECT existing.id,r.name,r.normalized_name FROM corrections r
            JOIN LATERAL (SELECT id FROM listings WHERE name=r.name AND normalized_name IS DISTINCT FROM r.normalized_name OFFSET 0) existing ON true
          ) UPDATE listings l SET normalized_name=t.normalized_name
            FROM targets t WHERE l.id=t.id AND l.name=t.name
              AND l.normalized_name IS DISTINCT FROM t.normalized_name`,
          [JSON.stringify(batch)],
        );
        return {
          listings: listings.rowCount ?? 0,
          products: products.rowCount ?? 0,
        };
      });
      progress.listings += updated.listings;
      progress.products += updated.products;
      progress.completed += batch.length;
      onProgress?.({ ...progress });
    }
    await pool.query(
      "UPDATE catalog_browser_state SET requested_at=clock_timestamp() WHERE key='catalog'",
    );
    return progress;
  });
}
