import { settings } from "@/nextsignal/config";
import {
  localRuleKey,
  localMatchingVersion,
} from "@/nextsignal/domain/local-matching";
import { pool } from "@/nextsignal/services/database";
import { browserStatus } from "@/nextsignal/services/catalog-browser";
let indexedSnapshot: { key: string; version: string } | null = null;

export async function indexLocalProducts() {
  const rules = settings.matching.local;
  const version = localMatchingVersion(rules);
  if (!settings.matching.enabled || !rules.enabled) return 0;
  const status = await browserStatus();
  if (
    status.dirty ||
    (indexedSnapshot !== null &&
      indexedSnapshot.key === status.snapshot_key &&
      indexedSnapshot.version === version)
  )
    return 0;
  const rows = (
    await pool.query(
      `WITH batch AS MATERIALIZED (
       SELECT b.retailer,b.identity_hash,b.external_key,b.listing_id FROM catalog_browser b
       LEFT JOIN local_product_keys k ON k.retailer=b.retailer AND k.identity_hash=b.identity_hash AND k.external_key=b.external_key
       WHERE b.usable_name AND (k.version IS DISTINCT FROM $1 OR k.listing_id IS DISTINCT FROM b.listing_id)
       ORDER BY b.listing_id LIMIT $2
     ) SELECT batch.*,l.name,l.attributes FROM batch JOIN listings l ON l.id=batch.listing_id`,
      [version, rules.index_batch_size],
    )
  ).rows;
  if (!rows.length) {
    indexedSnapshot = { key: status.snapshot_key, version };
    return 0;
  }
  const prepared = rows.map((row) => ({
    ...row,
    rule_key: localRuleKey(row.name, row.attributes, rules),
  }));
  await pool.query(
    `INSERT INTO local_product_keys(retailer,identity_hash,external_key,listing_id,version,rule_key)
    SELECT r->>'retailer',r->>'identity_hash',r->>'external_key',(r->>'listing_id')::uuid,$2,r->>'rule_key'
    FROM jsonb_array_elements($1::jsonb) r
    ON CONFLICT(retailer,identity_hash,external_key) DO UPDATE
    SET listing_id=excluded.listing_id,version=excluded.version,rule_key=excluded.rule_key`,
    [JSON.stringify(prepared), version],
  );
  return rows.length;
}
