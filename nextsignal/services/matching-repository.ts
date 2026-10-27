import { grantChangedProducts } from "./task-automation";
import {
  availableProductSql,
  aggregateAvailabilitySql,
  assertProductAvailable,
} from "./product-availability";
import { readSettings } from "./task-settings";
import {
  matchingConfig,
  taskContext,
  checkpoint,
} from "@/nextsignal/services/task-context";
import { logEvent, withLogContext } from "@/nextsignal/adapters/log-context";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  manualLinks,
  pairKey,
} from "@/nextsignal/services/manual-match-memory";
import { settings } from "@/nextsignal/config";
import { readableProductText } from "@/nextsignal/domain/product-text";
import { pool, transaction } from "@/nextsignal/services/database";
import { hash, normalizeName } from "@/nextsignal/domain/normalize";
import { storeProductKey } from "@/nextsignal/domain/source-product-identity";
import {
  familyFromText,
  prepareFacts,
  inputFingerprint,
  localKey,
  groupProblem,
  requestProduct,
  refreshProductFacts,
  type StoreProduct,
  type Candidate,
  type Comparison,
  type ProductInput,
  type Facts,
  type Family,
  type Outcome,
} from "@/nextsignal/domain/matching";

type SourceListing = ProductInput & {
  id: string;
  retailer: string;
  external_key: string;
  identity_hash: string;
  product_id: string;
  source_id: string;
  match_status: string;
  identity_base?: string | null;
};
export type Campaign = {
  id: string;
  kind: "initial" | "incremental" | "evaluation";
  state: "running" | "paused" | "completed";
  reason: string;
  source_id: string | null;
  run_id: string | null;
};
export type Work = {
  id: string;
  store_product_id: string;
  campaign_id: string | null;
  token: string;
  reason: string;
};
const active = `EXISTS(SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active WHERE ss.store_product_id=sp.id)`;
const productSelect = `SELECT sp.*,sp.version::int AS version,p.matching_version::int AS group_version,
 (SELECT availability FROM store_product_availability WHERE store_product_id=sp.id) AS availability FROM store_products sp JOIN products p ON p.id=sp.group_id`;
const currentFacts = (product: StoreProduct) =>
  refreshProductFacts(
    product,
    matchingConfig().local,
    matchingConfig().category_mappings,
  );

type IndexChanges = {
  observations: number;
  products_changed: number;
  work_queued: number;
  legacy_conflict_records: number;
};
const emptyChanges = (): IndexChanges => ({
  observations: 0,
  products_changed: 0,
  work_queued: 0,
  legacy_conflict_records: 0,
});
function addChanges(total: IndexChanges, next: IndexChanges) {
  for (const key of Object.keys(total) as (keyof IndexChanges)[])
    total[key] += next[key];
}
export async function indexListings(
  c: PoolClient,
  rows: SourceListing[],
  publication?: { authorizeChanges: true },
): Promise<IndexChanges> {
  if (!rows.length) return emptyChanges();
  // Never collapse separately protected human decisions during a later import.
  const protectedAliases = (
    await c.query<{ listing_id: string; external_key: string }>(
      `SELECT a.listing_id,sp.external_key FROM store_product_aliases a JOIN store_products sp ON sp.id=a.store_product_id
      WHERE a.listing_id=ANY($1::uuid[]) AND sp.duplicate_conflict`,
      [rows.map((r) => r.id)],
    )
  ).rows;
  const protectedKeys = new Map(
    protectedAliases.map((r) => [r.listing_id, r.external_key]),
  );
  const fingerprinted = rows.map((row) => ({
    ...row,
    external_key:
      protectedKeys.get(row.id) ??
      storeProductKey(row.external_key, row.identity_base),
    fingerprint: inputFingerprint(row),
  }));
  const existing = (
    await c.query<StoreProduct>(
      `SELECT sp.* FROM store_products sp
     JOIN jsonb_to_recordset($1::jsonb) AS incoming(retailer text,external_key text,fingerprint text)
       ON sp.retailer=incoming.retailer AND sp.external_key=incoming.external_key AND sp.fingerprint=incoming.fingerprint
     FOR KEY SHARE OF sp`,
      [
        JSON.stringify(
          fingerprinted.map((r) => ({
            retailer: r.retailer,
            external_key: r.external_key,
            fingerprint: r.fingerprint,
          })),
        ),
      ],
    )
  ).rows;
  const existingByIdentity = new Map(
    existing.map((p) => [
      `${p.retailer}:${p.external_key}:${p.fingerprint}`,
      p,
    ]),
  );
  const roots = (
    await c.query<{ origin: string; id: string }>(
      `WITH RECURSIVE chain AS (
    SELECT id AS origin,id,redirect_id FROM products WHERE id=ANY($1::uuid[])
    UNION SELECT chain.origin,p.id,p.redirect_id FROM chain JOIN products p ON p.id=chain.redirect_id
  ) SELECT origin,id FROM chain WHERE redirect_id IS NULL`,
      [[...new Set(rows.map((r) => r.product_id))]],
    )
  ).rows;
  const rootById = new Map(roots.map((r) => [r.origin, r.id]));
  const prepared = fingerprinted.map((row) => {
    const saved = existingByIdentity.get(
      `${row.retailer}:${row.external_key}:${row.fingerprint}`,
    );
    const family =
      saved?.family ??
      familyFromText(row, row.retailer, matchingConfig().category_mappings);
    const facts =
      saved?.facts ?? prepareFacts(row, family, matchingConfig().local);
    return {
      ...row,
      product_id: rootById.get(row.product_id) ?? row.product_id,
      normalized_name: normalizeName(
        readableProductText(row.name, row.retailer),
      ),
      facts,
      family,
      category_hints: [],
      local_key: saved
        ? saved.local_key
        : localKey(
            readableProductText(row.name, row.retailer),
            facts,
            row.ambiguous,
            matchingConfig().local,
          ),
    };
  });
  // One canonical row per chain/article/descriptive revision, even when many
  // branch copies appear in this batch. Source IDs never enter matching inputs.
  const uniqueRows = new Map<string, (typeof prepared)[number]>();
  for (const row of prepared) {
    const key = `${row.retailer}:${row.external_key}:${row.fingerprint}`;
    const previous = uniqueRows.get(key);
    // An unmatched branch copy must never overwrite an accepted legacy group
    // merely because its UUID sorts later in this migration chunk.
    if (
      !previous ||
      (previous.match_status !== "matched" && row.match_status === "matched")
    )
      uniqueRows.set(
        key,
        previous?.ambiguous
          ? { ...row, ambiguous: true, local_key: null }
          : row,
      );
    else if (row.ambiguous && !previous.ambiguous)
      uniqueRows.set(key, { ...previous, ambiguous: true, local_key: null });
  }
  const unique = [...uniqueRows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row);
  // New branch observations reuse the canonical chain product. Only absent
  // identities or preserved legacy matches can change its row. Avoid running
  // an UPSERT (and taking update locks) for every unchanged branch copy.
  // The conflict clause still protects a concurrent insertion after our read.
  const productChanges = unique.filter((row) => {
    const saved = existingByIdentity.get(
      `${row.retailer}:${row.external_key}:${row.fingerprint}`,
    );
    return (
      !saved || (saved.state === "pending" && row.match_status === "matched")
    );
  });
  const inserted = productChanges.length
    ? await c.query<{ id: string }>(
        `INSERT INTO store_products(retailer,external_key,fingerprint,source_identity_hash,name,description,category,gtin,normalized_name,ambiguous,facts,family,category_hints,local_key,group_id,state,last_reason)
    SELECT r->>'retailer',r->>'external_key',r->>'fingerprint',r->>'identity_hash',r->>'name',r->>'description',r->>'category',r->>'gtin',r->>'normalized_name',(r->>'ambiguous')::boolean,r->'facts',r->>'family',r->'category_hints',r->>'local_key',(r->>'product_id')::uuid,
      CASE WHEN r->>'match_status'='matched' THEN 'matched' ELSE 'pending' END,
      CASE WHEN r->>'match_status'='matched' THEN 'Preserved existing product connection' ELSE 'New store product' END
    FROM jsonb_array_elements($1::jsonb) r ON CONFLICT(retailer,external_key,fingerprint) DO UPDATE
      SET group_id=excluded.group_id,state=excluded.state,last_reason=excluded.last_reason
      WHERE store_products.state='pending' AND excluded.state='matched' RETURNING id`,
        [JSON.stringify(productChanges)],
      )
    : { rows: [], rowCount: 0 };
  const conflicts = await c.query(
    `WITH conflicts AS (
    SELECT DISTINCT sp.group_id,(r->>'product_id')::uuid AS previous_group_id
    FROM jsonb_array_elements($1::jsonb) r JOIN store_products sp
      ON sp.retailer=r->>'retailer' AND sp.external_key=r->>'external_key' AND sp.fingerprint=r->>'fingerprint'
    WHERE r->>'match_status'='matched' AND sp.group_id<>(r->>'product_id')::uuid
      AND NOT EXISTS(SELECT 1 FROM manual_product_links ml WHERE ml.a_id=sp.id OR ml.b_id=sp.id)
  ), flagged AS (
    UPDATE products SET matching_conflict=true WHERE id IN (
      SELECT group_id FROM conflicts UNION SELECT previous_group_id FROM conflicts
    ) RETURNING id
  ) UPDATE store_products SET state='legacy_conflict',last_reason='Existing branch connections disagree about the shared product'
    WHERE group_id IN (SELECT id FROM flagged)`,
    [JSON.stringify(prepared)],
  );
  await c.query(
    `INSERT INTO store_product_observations(listing_id,store_product_id,previous_group_id)
    SELECT (r->>'id')::uuid,sp.id,(r->>'product_id')::uuid FROM jsonb_array_elements($1::jsonb) r JOIN store_products sp
      ON sp.retailer=r->>'retailer' AND sp.external_key=r->>'external_key' AND sp.fingerprint=r->>'fingerprint'
    ON CONFLICT DO NOTHING`,
    [JSON.stringify(prepared)],
  );
  await c.query(
    `INSERT INTO store_product_aliases(listing_id,store_product_id,source_id,source_identity_hash)
    SELECT (r->>'id')::uuid,sp.id,(r->>'source_id')::uuid,r->>'identity_hash' FROM jsonb_array_elements($1::jsonb) r JOIN store_products sp
      ON sp.retailer=r->>'retailer' AND sp.external_key=r->>'external_key' AND sp.fingerprint=r->>'fingerprint'
    ON CONFLICT(listing_id) DO UPDATE SET store_product_id=excluded.store_product_id,source_id=excluded.source_id,source_identity_hash=excluded.source_identity_hash
    WHERE (store_product_aliases.store_product_id,store_product_aliases.source_id,store_product_aliases.source_identity_hash)
      IS DISTINCT FROM (excluded.store_product_id,excluded.source_id,excluded.source_identity_hash)`,
    [JSON.stringify(prepared)],
  );
  let queued = 0;
  if (inserted.rowCount) {
    if (publication?.authorizeChanges)
      await grantChangedProducts(
        c,
        inserted.rows.map((r) => r.id),
        "import",
      );
    await c.query(
      `INSERT INTO product_membership_history(store_product_id,to_group_id)
      SELECT id,group_id FROM store_products WHERE id=ANY($1::uuid[])`,
      [inserted.rows.map((r) => r.id)],
    );
    const work = await c.query(
      `INSERT INTO matching_work(store_product_id,reason) SELECT unnest($1::uuid[]),'New or changed store product' ON CONFLICT DO NOTHING`,
      [inserted.rows.map((r) => r.id)],
    );
    queued = work.rowCount ?? 0;
  }
  return {
    observations: rows.length,
    products_changed: inserted.rowCount ?? 0,
    work_queued: queued,
    legacy_conflict_records: conflicts.rowCount ?? 0,
  };
}

export async function preserveSourceProducts(c: PoolClient, sourceId: string) {
  const rows = (
    await c.query<SourceListing>(
      `SELECT l.id,l.retailer,l.external_key,l.raw->>'identity_base' AS identity_base,l.identity_hash,l.product_id,l.name,l.description,l.category,l.gtin,
    l.raw->>'identity_ambiguous'='true' AS ambiguous,l.match_status,s.id AS source_id
    FROM listings l JOIN sources s ON s.retailer=l.retailer AND s.external_id=l.namespace
    WHERE s.id=$1 AND NOT EXISTS(SELECT 1 FROM store_product_aliases a WHERE a.listing_id=l.id)
    ORDER BY l.id FOR UPDATE OF l`,
      [sourceId],
    )
  ).rows.map((r) => ({ ...r, ambiguous: r.ambiguous === true }));
  const changes = emptyChanges();
  for (let i = 0; i < rows.length; i += matchingConfig().backfill_batch_size)
    addChanges(
      changes,
      await indexListings(
        c,
        rows.slice(i, i + matchingConfig().backfill_batch_size),
      ),
    );
  return changes;
}

export async function synchronizeSource(c: PoolClient, sourceId: string) {
  const rows = (
    await c.query<SourceListing>(
      `SELECT l.id,l.retailer,l.external_key,l.raw->>'identity_base' AS identity_base,l.identity_hash,l.product_id,l.name,l.description,l.category,l.gtin,
    l.raw->>'identity_ambiguous'='true' AS ambiguous,l.match_status,o.source_id
    FROM offers o JOIN listings l ON l.id=o.listing_id
    LEFT JOIN store_product_aliases a ON a.listing_id=l.id
    LEFT JOIN store_products sp ON sp.id=a.store_product_id
    WHERE o.source_id=$1 AND (a.listing_id IS NULL OR a.source_id<>o.source_id
      OR coalesce(a.source_identity_hash,sp.source_identity_hash) IS DISTINCT FROM l.identity_hash
      OR l.match_status='matched'
      OR NOT EXISTS(SELECT 1 FROM store_product_observations ob WHERE ob.listing_id=l.id AND ob.store_product_id=sp.id))
    ORDER BY l.id`,
      [sourceId],
    )
  ).rows.map((r) => ({ ...r, ambiguous: r.ambiguous === true }));
  // All batches share the catalog publication transaction, so no partial alias
  // or change event becomes visible if the import fails.
  const changes = emptyChanges();
  for (let i = 0; i < rows.length; i += matchingConfig().backfill_batch_size)
    addChanges(
      changes,
      await indexListings(
        c,
        rows.slice(i, i + matchingConfig().backfill_batch_size),
        { authorizeChanges: true },
      ),
    );
  const conflicts = await refreshSourcePrices(c, sourceId);
  // A disappeared unresolved product may return after its old campaign ended.
  // Completed work and saved matches remain untouched.
  const restored = await c.query(
    `UPDATE matching_work w SET campaign_id=NULL,state='pending',error=NULL,updated_at=now()
    FROM matching_campaigns mc WHERE mc.id=w.campaign_id AND mc.state='completed' AND w.state IN ('pending','deferred')
      AND EXISTS(SELECT 1 FROM store_product_sources ss WHERE ss.source_id=$1 AND ss.store_product_id=w.store_product_id)`,
    [sourceId],
  );
  return { ...changes, ...conflicts, work_restored: restored.rowCount ?? 0 };
}
export async function refreshSourcePrices(c: PoolClient, sourceId: string) {
  const previousAvailable = (
    await c.query<{ id: string }>(
      `SELECT sp.id FROM store_products sp WHERE sp.id IN(
    SELECT store_product_id FROM store_product_sources WHERE source_id=$1 UNION SELECT store_product_id FROM store_product_aliases WHERE source_id=$1)
    AND ${availableProductSql("sp")}`,
      [sourceId],
    )
  ).rows.map((r) => r.id);
  await c.query(
    `DELETE FROM store_product_sources WHERE source_id=$1 AND store_product_id NOT IN (
      SELECT a.store_product_id FROM offers o JOIN store_product_aliases a ON a.listing_id=o.listing_id WHERE o.source_id=$1
    )`,
    [sourceId],
  );
  await c.query(
    `INSERT INTO store_product_sources(store_product_id,source_id,price,highest_price,offer_count,retrieved_at,duplicate_count,price_conflict,available)
    SELECT a.store_product_id,o.source_id,min(o.price),max(o.price),count(*)::int,max(o.retrieved_at),
      (count(*)-count(DISTINCT jsonb_build_array(o.price,o.regular_price,o.promo_price,o.unit_price,o.available,o.promotion)))::int,
      count(DISTINCT o.price)>1,${aggregateAvailabilitySql}
    FROM offers o JOIN store_product_aliases a ON a.listing_id=o.listing_id
    WHERE o.source_id=$1 GROUP BY a.store_product_id,o.source_id
    ON CONFLICT(store_product_id,source_id) DO UPDATE SET price=excluded.price,highest_price=excluded.highest_price,
      offer_count=excluded.offer_count,retrieved_at=excluded.retrieved_at,
      duplicate_count=excluded.duplicate_count,price_conflict=excluded.price_conflict,available=excluded.available`,
    [sourceId],
  );
  await c.query(
    "UPDATE sources SET availability_indexed_at=clock_timestamp() WHERE id=$1",
    [sourceId],
  );
  await c.query(
    "INSERT INTO dashboard_refresh_events(transaction_id) VALUES(txid_current()) ON CONFLICT DO NOTHING",
  );
  const becameAvailable = (
    await c.query<{ id: string }>(
      `SELECT sp.id FROM store_products sp WHERE
    EXISTS(SELECT 1 FROM store_product_sources ss WHERE ss.store_product_id=sp.id AND ss.source_id=$1)
    AND NOT(sp.id=ANY($2::uuid[])) AND ${availableProductSql("sp")}`,
      [sourceId, previousAvailable],
    )
  ).rows.map((r) => r.id);
  if (becameAvailable.length)
    await grantChangedProducts(c, becameAvailable, "import");
  const affected = (
    await c.query<{ store_product_id: string }>(
      "SELECT DISTINCT store_product_id FROM store_product_aliases WHERE source_id=$1",
      [sourceId],
    )
  ).rows.map((row) => row.store_product_id);
  const conflicts = await refreshIdentitySafety(c, affected);
  const counts = (
    await c.query(
      `SELECT coalesce(sum(duplicate_count),0)::int AS identical_duplicate_rows,
    count(*) FILTER(WHERE price_conflict)::int AS price_conflicts FROM store_product_sources WHERE source_id=$1`,
      [sourceId],
    )
  ).rows[0];
  return {
    ...conflicts,
    ...counts,
    products_became_available: becameAvailable.length,
  };
}

export async function refreshIdentitySafety(c: PoolClient, ids: string[]) {
  // Identical descriptions are one product, even when the publisher repeats a
  // row or changes its price. Only distinct descriptions under the same source
  // identifier in the same active catalog make that identifier ambiguous.
  const reliability = (
    await c.query<StoreProduct>(
      `WITH affected AS MATERIALIZED (
        SELECT DISTINCT sp.retailer,sp.external_key FROM store_products sp
        WHERE sp.id=ANY($1::uuid[])
      ), members AS MATERIALIZED (
        SELECT sp.id,sp.retailer,sp.external_key,sp.fingerprint,sp.ambiguous,sp.duplicate_conflict FROM store_products sp JOIN affected x
          ON x.retailer=sp.retailer AND x.external_key=sp.external_key
      ), retailers AS MATERIALIZED (
        SELECT DISTINCT retailer FROM affected
      ), flagged_retailers AS MATERIALIZED (
        SELECT retailer FROM retailers r WHERE EXISTS (
          SELECT 1 FROM listings l WHERE l.retailer=r.retailer
            AND coalesce((l.raw->>'identity_ambiguous')::boolean,false)
        )
      ), evaluated AS MATERIALIZED (
        SELECT m.id,m.ambiguous AS previous,
          m.duplicate_conflict OR CASE WHEN m.retailer IN (SELECT retailer FROM flagged_retailers) THEN EXISTS (
            SELECT 1 FROM store_product_sources own
            JOIN store_product_sources sibling ON sibling.source_id=own.source_id AND sibling.store_product_id<>own.store_product_id
            JOIN store_products other ON other.id=sibling.store_product_id
              AND other.retailer=m.retailer AND other.external_key=m.external_key AND other.fingerprint<>m.fingerprint
            JOIN sources src ON src.id=own.source_id AND src.active
            WHERE own.store_product_id=m.id
              AND EXISTS(SELECT 1 FROM store_product_aliases a JOIN offers o ON o.listing_id=a.listing_id AND o.source_id=a.source_id WHERE a.store_product_id=own.store_product_id AND a.source_id=own.source_id)
              AND EXISTS(SELECT 1 FROM store_product_aliases a JOIN offers o ON o.listing_id=a.listing_id AND o.source_id=a.source_id WHERE a.store_product_id=sibling.store_product_id AND a.source_id=sibling.source_id)
          ) ELSE false END AS ambiguous FROM members m
      ), current AS MATERIALIZED (
        SELECT id,ambiguous FROM evaluated WHERE previous IS DISTINCT FROM ambiguous
      ) UPDATE store_products sp SET ambiguous=current.ambiguous,version=version+1,
        state='needs_info',last_reason=CASE WHEN current.ambiguous
          THEN 'The store repeated an article identifier; product identity needs review'
          ELSE 'Source identifiers now agree; ready to recheck' END,updated_at=now()
        FROM current WHERE sp.id=current.id
          AND EXISTS (
            SELECT 1 FROM store_product_aliases a
            JOIN offers o ON o.listing_id=a.listing_id AND o.source_id=a.source_id
            JOIN sources src ON src.id=a.source_id AND src.active
            WHERE a.store_product_id=sp.id
          ) RETURNING sp.*`,
      [ids],
    )
  ).rows;
  for (const product of reliability)
    await c.query("UPDATE store_products SET local_key=$2 WHERE id=$1", [
      product.id,
      localKey(
        readableProductText(product.name, product.retailer),
        product.facts,
        product.ambiguous,
        matchingConfig().local,
      ),
    ]);
  const changes = (
    await c.query<{ id: string; branch_conflict: boolean }>(
      `WITH affected AS (
    SELECT DISTINCT sp.retailer,sp.external_key FROM store_products sp WHERE sp.id=ANY($1::uuid[])
  ), counts AS (
    SELECT sp.retailer,sp.external_key,count(*) FILTER(WHERE ${active})>1 AS conflict
    FROM store_products sp JOIN affected a ON a.retailer=sp.retailer AND a.external_key=sp.external_key GROUP BY sp.retailer,sp.external_key
  ) UPDATE store_products sp SET branch_conflict=counts.conflict,version=version+1,
    state='needs_info',last_reason=CASE WHEN counts.conflict THEN 'Branches disagree about this store article' WHEN sp.ambiguous THEN 'The store repeated an article identifier; product identity needs review' ELSE 'Branch descriptions now agree; ready to recheck' END
    FROM counts WHERE counts.retailer=sp.retailer AND counts.external_key=sp.external_key AND sp.branch_conflict IS DISTINCT FROM counts.conflict RETURNING sp.id,sp.branch_conflict`,
      [ids],
    )
  ).rows;
  if (changes.length || reliability.length)
    await c.query(
      `UPDATE matching_work SET state='pending',campaign_id=NULL,reason='Branch identity changed' WHERE store_product_id=ANY($1::uuid[]) AND state IN ('completed','deferred')`,
      [[...new Set([...changes, ...reliability].map((p) => p.id))]],
    );
  return {
    source_reliability_changed: reliability.length,
    branch_conflicts_opened: changes.filter((p) => p.branch_conflict).length,
    branch_conflicts_resolved: changes.filter((p) => !p.branch_conflict).length,
  };
}

export async function backfillStoreProducts() {
  return withLogContext({}, async () => {
    try {
      return await backfillScoped();
    } catch (error) {
      await logEvent(
        "error",
        "matching.backfill.failed",
        "Store product indexing failed; inspect the last saved checkpoint",
        {},
        error,
      );
      throw error;
    }
  });
}
async function backfillScoped() {
  const started = Date.now();
  let progressed = false,
    cursor: string | null = null,
    changes = emptyChanges(),
    legacyConflicts = 0;
  const result = await transaction(async (c) => {
    const state = (
      await c.query(
        `SELECT * FROM matching_state WHERE key='store-products' FOR UPDATE`,
      )
    ).rows[0];
    if (state.completed) return { processed: 0, completed: true };
    progressed = true;
    const rows = (
      await c.query<SourceListing>(
        `SELECT l.id,l.retailer,l.external_key,l.raw->>'identity_base' AS identity_base,l.identity_hash,l.product_id,l.name,l.description,l.category,l.gtin,
      l.raw->>'identity_ambiguous'='true' AS ambiguous,l.match_status,s.id AS source_id
      FROM listings l JOIN sources s ON s.retailer=l.retailer AND s.external_id=l.namespace
      WHERE ($1::uuid IS NULL OR l.id>$1) ORDER BY l.id LIMIT $2 FOR UPDATE OF l`,
        [state.cursor, matchingConfig().backfill_batch_size],
      )
    ).rows.map((r) => ({ ...r, ambiguous: r.ambiguous === true }));
    changes = await indexListings(c, rows);
    cursor = rows.at(-1)?.id ?? state.cursor;
    const ids = rows.map((r) => r.id);
    // Upsert only migrated observations; do not scan every branch after every
    // cursor page. The final row counts are sums over the aliases already saved.
    if (ids.length)
      await c.query(
        `WITH touched AS (
        SELECT DISTINCT store_product_id,source_id FROM store_product_aliases WHERE listing_id=ANY($1::uuid[])
      ) INSERT INTO store_product_sources(store_product_id,source_id,price,highest_price,offer_count,retrieved_at)
      SELECT a.store_product_id,o.source_id,min(o.price),max(o.price),count(*)::int,max(o.retrieved_at)
      FROM touched t JOIN store_product_aliases a ON a.store_product_id=t.store_product_id AND a.source_id=t.source_id
      JOIN offers o ON o.listing_id=a.listing_id AND o.source_id=t.source_id
      GROUP BY a.store_product_id,o.source_id
      ON CONFLICT(store_product_id,source_id) DO UPDATE SET price=excluded.price,highest_price=excluded.highest_price,offer_count=excluded.offer_count,retrieved_at=excluded.retrieved_at`,
        [ids],
      );
    const completed = rows.length < matchingConfig().backfill_batch_size;
    await c.query(
      `UPDATE matching_state SET cursor=coalesce($1,cursor),completed=$2 WHERE key='store-products'`,
      [rows.at(-1)?.id ?? null, completed],
    );
    if (completed) legacyConflicts = await auditGroups(c);
    return { processed: rows.length, completed };
  });
  if (progressed) {
    await logEvent(
      "info",
      "matching.backfill.checkpoint",
      "Store product indexing checkpoint saved",
      { ...result, ...changes, cursor, duration_ms: Date.now() - started },
    );
    if (legacyConflicts)
      await logEvent(
        "warn",
        "matching.backfill.conflicts",
        "Existing product connections need attention",
        { legacy_conflict_records: legacyConflicts },
      );
  }
  return result;
}

async function auditGroups(c: PoolClient) {
  await c.query(`WITH conflicts AS (
    SELECT sp.retailer,sp.external_key FROM store_products sp WHERE ${active}
    GROUP BY sp.retailer,sp.external_key HAVING count(*)>1
  ) UPDATE store_products sp SET branch_conflict=true,version=version+1,state='needs_info',last_reason='Branches disagree about this store article'
    FROM conflicts c WHERE c.retailer=sp.retailer AND c.external_key=sp.external_key AND NOT sp.branch_conflict`);
  // Existing connections are kept, including unsafe legacy groups. They are
  // marked explicitly and cannot receive new members automatically.
  await c.query(`UPDATE products p SET matching_conflict=true WHERE EXISTS(
    SELECT 1 FROM store_products sp WHERE sp.group_id=p.id AND ${active}
    GROUP BY sp.retailer HAVING count(*)>1)`);
  await c.query(`UPDATE products p SET matching_conflict=true WHERE EXISTS(
    SELECT 1 FROM store_products a JOIN store_products b ON b.group_id=a.group_id AND b.id>a.id
    JOIN LATERAL jsonb_each(a.facts) af ON true JOIN LATERAL jsonb_each(b.facts) bf ON bf.key=af.key
    WHERE a.group_id=p.id AND af.value->>'value'<>bf.value->>'value'
      AND EXISTS(SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active WHERE ss.store_product_id=a.id)
      AND EXISTS(SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active WHERE ss.store_product_id=b.id))`);
  const flagged =
    await c.query(`UPDATE store_products sp SET state='legacy_conflict',last_reason='Existing group contains conflicting store products'
    FROM products p WHERE p.id=sp.group_id AND p.matching_conflict`);
  return flagged.rowCount ?? 0;
}

export async function getProduct(id: string): Promise<StoreProduct> {
  const row = (
    await pool.query<StoreProduct>(
      `WITH RECURSIVE resolved AS (
        SELECT $1::uuid AS id UNION
        SELECT r.to_id FROM store_product_redirects r JOIN resolved previous ON previous.id=r.from_id
      ) ${productSelect} WHERE sp.id IN (SELECT id FROM resolved)
        AND NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id)`,
      [id],
    )
  ).rows[0];
  if (!row) throw new Error("Store product not found");
  return row;
}
export async function groupMembers(
  groupId: string,
  c?: PoolClient,
): Promise<StoreProduct[]> {
  return (c ?? pool)
    .query<StoreProduct>(
      `${productSelect} WHERE sp.group_id=$1 AND ${active} ORDER BY sp.id`,
      [groupId],
    )
    .then((r) => r.rows.map(currentFacts));
}
export async function findCandidates(
  query: StoreProduct,
  mode: "all" | "rules" | "ai" = "all",
): Promise<Candidate[]> {
  const brands = query.facts.brand?.value ?? null,
    gtin = query.facts.gtin?.value ?? null;
  const weights = matchingConfig().candidate_weights;
  const rows = await transaction(async (c) => {
    await c.query(`SELECT set_config('pg_trgm.similarity_threshold',$1,true)`, [
      String(matchingConfig().candidate_similarity),
    ]);
    return (
      await c.query<StoreProduct & { score: number; reasons: string[] }>(
        `WITH candidates AS (
    SELECT sp.*,sp.version::int AS version,
      similarity(sp.normalized_name,$1)::float AS name_score,
      array_remove(ARRAY[CASE WHEN $4::text IS NOT NULL AND sp.gtin=$4 THEN 'Same validated barcode' END,
        CASE WHEN $5::text IS NOT NULL AND sp.local_key=$5 THEN 'Same exact name signature' END,
        CASE WHEN $6::text IS NOT NULL AND sp.facts->'brand'->>'value'=$6 THEN 'Same reviewed brand' END,
        CASE WHEN sp.family=$7 AND sp.family<>'unknown' THEN 'Related category' END,
        CASE WHEN sp.facts->'quantity'->>'value'=$9 AND sp.facts->'unit'->>'value'=$10 THEN 'Same stated amount' END,'Similar product name'],NULL) AS reasons
    FROM store_products sp JOIN products p ON p.id=sp.group_id AND NOT p.matching_conflict
    WHERE sp.retailer<>$2 AND sp.group_id<>$3 AND NOT sp.ambiguous AND NOT sp.branch_conflict AND ${availableProductSql("sp")}
      AND ($16='all' OR ($16='rules' AND (($4::text IS NOT NULL AND sp.gtin=$4) OR ($5::text IS NOT NULL AND sp.local_key=$5)))
        OR ($16='ai' AND sp.classified_family=ANY($17::text[]) AND NOT EXISTS(
          SELECT 1 FROM store_products gm WHERE gm.group_id=sp.group_id
            AND EXISTS(SELECT 1 FROM store_product_sources gs JOIN sources src ON src.id=gs.source_id AND src.active WHERE gs.store_product_id=gm.id)
            AND (gm.classified_family IS NULL OR NOT (gm.classified_family=ANY($17::text[])))
        )))
      AND (sp.normalized_name % $1 OR ($4::text IS NOT NULL AND sp.gtin=$4) OR ($5::text IS NOT NULL AND sp.local_key=$5)
        OR ($6::text IS NOT NULL AND sp.facts->'brand'->>'value'=$6 AND similarity(sp.normalized_name,$1)>0)
        OR ($9::text IS NOT NULL AND sp.facts->'quantity'->>'value'=$9 AND sp.facts->'unit'->>'value'=$10 AND sp.family=$7 AND sp.family<>'unknown' AND similarity(sp.normalized_name,$1)>0))
  ), ranked AS (
    SELECT *,name_score+CASE WHEN gtin=$4 THEN $11::float ELSE 0 END+CASE WHEN local_key=$5 THEN $12::float ELSE 0 END+
      CASE WHEN facts->'brand'->>'value'=$6 THEN $13::float ELSE 0 END+
      CASE WHEN facts->'quantity'->>'value'=$9 AND facts->'unit'->>'value'=$10 THEN $14::float ELSE 0 END+
      CASE WHEN family=$7 AND family<>'unknown' THEN $15::float ELSE 0 END AS score,
      row_number() OVER(PARTITION BY group_id ORDER BY name_score DESC,id) AS position FROM candidates
  ) SELECT * FROM ranked WHERE position=1 ORDER BY score DESC,id LIMIT $8`,
        [
          query.normalized_name,
          query.retailer,
          query.group_id,
          gtin,
          query.local_key,
          brands,
          query.family,
          matchingConfig().candidate_limit,
          query.facts.quantity?.value ?? null,
          query.facts.unit?.value ?? null,
          weights.barcode,
          weights.signature,
          weights.brand,
          weights.quantity,
          weights.category,
          mode,
          matchingConfig().ai_categories,
        ],
      )
    ).rows;
  });
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const members = await groupMembers(row.group_id);
    const p = (
      await pool.query(
        "SELECT matching_version::int AS version FROM products WHERE id=$1",
        [row.group_id],
      )
    ).rows[0];
    candidates.push({
      product: currentFacts(row),
      members,
      group_version: p.version,
      reasons: row.reasons,
      score: Number(row.score),
    });
  }
  return candidates;
}

export async function markClassificationAttempt(
  product: StoreProduct,
  key: string,
) {
  return (
    (
      await pool.query(
        "UPDATE store_products SET classification_attempt_key=$2 WHERE id=$1 AND version=$3",
        [product.id, key, product.version],
      )
    ).rowCount === 1
  );
}

export async function saveClassification(
  product: StoreProduct,
  classification: {
    key: string;
    family: Family;
    hints: Family[];
    model: string;
    prompt_key: string;
    selected: string;
    probabilities: Record<string, number>;
    confidence: number | null;
    generation_id: string | null;
  },
) {
  const refreshed = currentFacts({
    ...product,
    classified_family: classification.family,
  });
  const saved = await transaction(async (c) => {
    await c.query(
      `INSERT INTO store_product_classifications(store_product_id,input_key,family,selected_family,probability,confidence,probabilities,acceptance_threshold,model,prompt_key,generation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [
        product.id,
        classification.key,
        classification.family,
        classification.selected,
        classification.probabilities[classification.selected],
        classification.confidence,
        classification.probabilities,
        matchingConfig().category_threshold,
        classification.model,
        classification.prompt_key,
        classification.generation_id,
      ],
    );
    return (
      await c.query(
        `UPDATE store_products SET classified_family=$2,classification_key=$3,classification_threshold=$4,
      family=$2,category_hints=$5,facts=$6,local_key=$7,version=version+1,updated_at=now() WHERE id=$1 AND version=$8 AND manual_family IS NULL RETURNING id`,
        [
          product.id,
          classification.family,
          classification.key,
          matchingConfig().category_threshold,
          JSON.stringify(classification.hints),
          refreshed.facts,
          refreshed.local_key,
          product.version,
        ],
      )
    ).rowCount;
  });
  await logEvent(
    "debug",
    saved ? "matching.classification.saved" : "matching.classification.stale",
    saved
      ? "Shared product category saved"
      : "Category answer retained in history; current product changed",
    {
      store_product_id: product.id,
      family: classification.family,
      selected_family: classification.selected,
      probability: classification.probabilities[classification.selected],
      confidence: classification.confidence,
      prompt_key: classification.prompt_key,
    },
  );
  return saved ? await getProduct(product.id) : null;
}

// Bounded background reconciliation when an excluded label is enabled later.
// Existing connections and cached classifications are never reset.
export async function requeueSelectedCategories(sourceId: string | null) {
  if (!matchingConfig().ai_categories.length) return 0;
  const result = await pool.query(
    `WITH selected AS (
    SELECT sp.id FROM store_products sp JOIN matching_work w ON w.store_product_id=sp.id
    WHERE sp.state='category_excluded' AND w.state='completed' AND sp.classified_family=ANY($1::text[]) AND ${availableProductSql("sp")}
      AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM store_product_aliases a WHERE a.store_product_id=sp.id AND a.source_id=$3))
    ORDER BY sp.id LIMIT $2 FOR UPDATE OF w SKIP LOCKED
  ) UPDATE matching_work w SET state='pending',campaign_id=NULL,reason='Category selected for AI matching',updated_at=now()
    FROM selected WHERE w.store_product_id=selected.id`,
    [
      matchingConfig().ai_categories,
      matchingConfig().backfill_batch_size,
      sourceId,
    ],
  );
  if (result.rowCount)
    await logEvent(
      "info",
      "matching.categories.requeued",
      "Previously excluded products queued after their category was enabled",
      { queued: result.rowCount, categories: matchingConfig().ai_categories },
    );
  return result.rowCount ?? 0;
}

// Products processed before category-first matching may have completed work but
// no saved category, including manually connected products. Queue their first
// categorization without resetting the group or reopening classified products.
export async function requeueUnclassifiedProducts(sourceId: string | null) {
  if (!matchingConfig().gateway.enabled) return 0;
  const result = await pool.query(
    `WITH selected AS (
    SELECT sp.id FROM store_products sp LEFT JOIN matching_work w ON w.store_product_id=sp.id
    WHERE sp.classification_key IS NULL AND sp.classification_attempt_key IS NULL AND sp.manual_family IS NULL AND NOT sp.ambiguous AND NOT sp.branch_conflict
      AND sp.state<>'legacy_conflict' AND (w.id IS NULL OR w.state='completed') AND ${availableProductSql("sp")}
      AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM store_product_aliases a WHERE a.store_product_id=sp.id AND a.source_id=$2))
    ORDER BY sp.id LIMIT $1 FOR UPDATE OF sp SKIP LOCKED
  ) INSERT INTO matching_work(store_product_id,reason)
    SELECT id,'Initial shared category needed' FROM selected
    ON CONFLICT(store_product_id) DO UPDATE SET state='pending',campaign_id=NULL,reason=excluded.reason,updated_at=now()
      WHERE matching_work.state='completed'`,
    [matchingConfig().backfill_batch_size, sourceId],
  );
  if (result.rowCount)
    await logEvent(
      "info",
      "matching.classification.queued",
      "Existing products queued for their first shared category",
      { queued: result.rowCount, source_id: sourceId },
    );
  return result.rowCount ?? 0;
}

export async function saveFacts(
  product: StoreProduct,
  facts: Facts,
  family: Family,
  hints: Family[],
) {
  const row = (
    await pool.query<StoreProduct>(
      `UPDATE store_products SET facts=$2,family=$3,category_hints=$4,local_key=$5,version=version+1,updated_at=now()
    WHERE id=$1 AND version=$6 RETURNING *,version::int AS version`,
      [
        product.id,
        facts,
        family,
        JSON.stringify(hints),
        localKey(
          readableProductText(product.name, product.retailer),
          facts,
          product.ambiguous,
          matchingConfig().local,
        ),
        product.version,
      ],
    )
  ).rows[0];
  return getProduct(row?.id ?? product.id);
}

export async function ensureCampaign(
  kind: Campaign["kind"],
  sourceId: string | null = null,
): Promise<Campaign> {
  let created = false;
  const campaign = await transaction(async (c) => {
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtext('matching-campaigns'))`,
    );
    const existing = (
      await c.query<Campaign>(
        `SELECT * FROM matching_campaigns WHERE kind=$1 AND ($1='initial' OR (source_id IS NOT DISTINCT FROM $2 AND state<>'completed')) ORDER BY created_at LIMIT 1`,
        [kind, sourceId],
      )
    ).rows[0];
    if (existing) return existing;
    created = true;
    return (
      await c.query<Campaign>(
        `INSERT INTO matching_campaigns(kind,state,reason,source_id) VALUES($1,'running','Matching products across stores',$2) RETURNING *`,
        [kind, sourceId],
      )
    ).rows[0];
  });
  if (created)
    await logEvent(
      "info",
      "matching.campaign.created",
      "Matching campaign created",
      {
        campaign_id: campaign.id,
        campaign_kind: campaign.kind,
        source_id: sourceId,
      },
    );
  return campaign;
}

export async function startPending(sourceId: string | null, force = false) {
  if (
    !matchingConfig().enabled ||
    (!matchingConfig().automatic_enabled && !force)
  ) {
    await logEvent(
      "debug",
      "matching.queue.skipped",
      "Matching queue check skipped",
      { source_id: sourceId, reason: "matching_disabled" },
    );
    return null;
  }
  await requeueUnclassifiedProducts(sourceId);
  await requeueSelectedCategories(sourceId);
  const state = (
    await pool.query(
      `SELECT completed FROM matching_state WHERE key='store-products'`,
    )
  ).rows[0];
  if (!state.completed) {
    await logEvent(
      "debug",
      "matching.queue.waiting",
      "Matching is waiting for store product indexing",
      { source_id: sourceId, reason: "indexing" },
    );
    return null;
  }
  if (
    (
      await pool.query(
        `SELECT 1 FROM runs WHERE kind IN ('discover','catalog') AND status IN ('pending','queued','running') LIMIT 1`,
      )
    ).rowCount
  ) {
    await logEvent(
      "debug",
      "matching.queue.waiting",
      "Matching is waiting for current price imports",
      { source_id: sourceId, reason: "imports_in_progress" },
    );
    return null;
  }
  if (
    !(
      await pool.query(
        `SELECT 1 FROM matching_work w JOIN store_products sp ON sp.id=w.store_product_id WHERE w.state IN ('pending','running','deferred') AND ${availableProductSql("sp")} LIMIT 1`,
      )
    ).rowCount
  ) {
    await logEvent(
      "debug",
      "matching.queue.skipped",
      "No active pending products need matching",
      { source_id: sourceId, reason: "no_pending_work" },
    );
    return null;
  }
  const initial = await ensureCampaign("initial");
  const campaign =
    initial.state === "completed"
      ? await ensureCampaign("incremental", sourceId)
      : initial;
  if (campaign.state !== "running") {
    await logEvent(
      "debug",
      "matching.queue.waiting",
      "Matching campaign is paused",
      {
        source_id: sourceId,
        campaign_id: campaign.id,
        reason: campaign.reason,
      },
    );
    return campaign;
  }
  let queued = false,
    assigned = 0;
  const result = await transaction(async (c) => {
    await c.query(`SELECT id FROM matching_campaigns WHERE id=$1 FOR UPDATE`, [
      campaign.id,
    ]);
    const assignment = await c.query(
      `WITH batch AS (
      SELECT w.id FROM matching_work w JOIN store_products sp ON sp.id=w.store_product_id
      WHERE w.campaign_id IS NULL AND w.state IN ('pending','deferred') AND ${availableProductSql("sp")}
        AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM store_product_aliases a WHERE a.store_product_id=sp.id AND a.source_id=$2))
      ORDER BY w.created_at,w.id LIMIT $3 FOR UPDATE OF w SKIP LOCKED
    ) UPDATE matching_work w SET campaign_id=$1,updated_at=now() FROM batch WHERE batch.id=w.id`,
      [campaign.id, sourceId, matchingConfig().backfill_batch_size],
    );
    assigned = assignment.rowCount ?? 0;
    const unfinished = (
      await c.query(
        `SELECT 1 FROM matching_work w JOIN store_products sp ON sp.id=w.store_product_id WHERE w.campaign_id=$1 AND w.state IN ('pending','running','deferred') AND ${availableProductSql("sp")} LIMIT 1`,
        [campaign.id],
      )
    ).rowCount;
    if (!unfinished) {
      await c.query(
        `UPDATE matching_campaigns SET state='completed',completed_at=now(),reason='Matching completed' WHERE id=$1
        AND (kind<>'initial' OR NOT EXISTS(SELECT 1 FROM matching_work w JOIN store_products sp ON sp.id=w.store_product_id WHERE w.campaign_id IS NULL AND w.state='pending' AND ${availableProductSql("sp")}))`,
        [campaign.id],
      );
      return campaign;
    }
    if (
      (
        await c.query(
          `SELECT 1 FROM runs WHERE kind='match' AND status IN ('pending','queued','running') LIMIT 1`,
        )
      ).rowCount
    )
      return campaign;
    const run = (
      await c.query(
        `INSERT INTO runs(kind,status,source_id,checkpoint) VALUES('match','pending',$1,jsonb_build_object('campaign_id',$2::text)) RETURNING id`,
        [sourceId, campaign.id],
      )
    ).rows[0];
    await c.query("UPDATE matching_campaigns SET run_id=$2 WHERE id=$1", [
      campaign.id,
      run.id,
    ]);
    queued = true;
    return { ...campaign, run_id: run.id };
  });
  if (queued)
    await logEvent(
      "info",
      "matching.campaign.queued",
      "Pending product matching queued",
      {
        campaign_id: campaign.id,
        run_id: result.run_id,
        source_id: sourceId,
        assigned_products: assigned,
      },
    );
  return result;
}
export async function campaignForRun(runId: string, sourceId: string | null) {
  // Publishing the run's campaign reference and assigning its work must be one
  // transaction: another worker must never observe the former without the latter.
  return transaction(async (c) => {
    await c.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [runId]);
    const existing = (
      await c.query<Campaign>(
        `SELECT mc.* FROM runs r JOIN matching_campaigns mc ON mc.id::text=r.checkpoint->>'campaign_id' WHERE r.id=$1`,
        [runId],
      )
    ).rows[0];
    const campaign =
      existing ?? (await ensureCampaign("incremental", sourceId));
    await c.query(
      `UPDATE runs SET checkpoint=checkpoint||jsonb_build_object('campaign_id',$2::text) WHERE id=$1`,
      [runId, campaign.id],
    );
    await c.query(
      `WITH batch AS (
      SELECT w.id FROM matching_work w JOIN store_products sp ON sp.id=w.store_product_id
      WHERE w.campaign_id IS NULL AND w.state='pending' AND ${availableProductSql("sp")}
        AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM store_product_aliases a WHERE a.store_product_id=sp.id AND a.source_id=$2))
      ORDER BY w.created_at,w.id LIMIT $3 FOR UPDATE OF w SKIP LOCKED
    ) UPDATE matching_work w SET campaign_id=$1 FROM batch WHERE w.id=batch.id`,
      [campaign.id, sourceId, matchingConfig().backfill_batch_size],
    );
    return campaign;
  });
}
export async function claimWork(campaignId: string): Promise<Work[]> {
  const work = await transaction(async (c) => {
    await c.query(
      `SELECT id FROM matching_campaigns WHERE id=$1 AND state='running' FOR UPDATE`,
      [campaignId],
    );
    const token = randomUUID();
    return (
      await c.query<Work & { recovered: boolean }>(
        `WITH batch AS (
      SELECT w.id,w.state='running' AS recovered FROM matching_work w JOIN store_products sp ON sp.id=w.store_product_id
      WHERE w.campaign_id=$1 AND (w.state='pending' OR (w.state='running' AND w.lease_until<now())) AND ${availableProductSql("sp")}
        AND EXISTS(SELECT 1 FROM matching_campaigns WHERE id=$1 AND state='running')
      ORDER BY w.created_at,w.id LIMIT $2 FOR UPDATE OF w SKIP LOCKED
    ) UPDATE matching_work w SET state='running',token=$3,lease_until=now()+$4*interval '1 second',attempts=attempts+1,updated_at=now()
      FROM batch WHERE w.id=batch.id RETURNING w.*,batch.recovered`,
        [
          campaignId,
          matchingConfig().batch_size,
          token,
          matchingConfig().lease_seconds,
        ],
      )
    ).rows;
  });
  if (work.length)
    await logEvent(
      "debug",
      "matching.work.claimed",
      "Pending matching work claimed",
      { campaign_id: campaignId, claimed: work.length },
    );
  const recovered = work.filter((w) => w.recovered);
  if (recovered.length)
    await logEvent(
      "warn",
      "matching.work.recovered",
      "Expired matching claims recovered",
      {
        campaign_id: campaignId,
        recovered: recovered.length,
        work_ids: recovered.map((w) => w.id),
      },
    );
  return work;
}
export async function finishWork(
  work: Work,
  key: string,
  state: "completed" | "deferred",
  error: string | null = null,
) {
  const result = await pool.query(
    `UPDATE matching_work SET state=$3,result_key=$4,error=$5,token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND token=$2`,
    [work.id, work.token, state, key, error],
  );
  await logEvent(
    "debug",
    result.rowCount ? "matching.work.finished" : "matching.work.stale",
    result.rowCount
      ? "Matching work checkpoint saved"
      : "Outdated matching work completion ignored",
    {
      campaign_id: work.campaign_id,
      store_product_id: work.store_product_id,
      work_id: work.id,
      state,
      reason: error,
    },
  );
}
export async function pauseCampaign(campaignId: string, reason: string) {
  const result = await pool.query(
    `UPDATE matching_campaigns SET state='paused',reason=$2,paused_at=now() WHERE id=$1 AND (state<>'paused' OR reason IS DISTINCT FROM $2)`,
    [campaignId, reason],
  );
  if (result.rowCount)
    await logEvent(
      "warn",
      "matching.campaign.paused",
      "Matching campaign paused",
      { campaign_id: campaignId, reason },
    );
}
export async function resumeMonthlyBudgets() {
  const rows = await transaction(async (c) => {
    const resumed = (
      await c.query<{ id: string }>(
        `UPDATE matching_campaigns SET state='running',reason='New monthly matching allowance',paused_at=NULL
    WHERE kind='incremental' AND state='paused' AND reason='Paused: spending or request limit reached'
      AND date_trunc('month',paused_at AT TIME ZONE $1)<date_trunc('month',now() AT TIME ZONE $1) RETURNING id`,
        [settings.app.timezone],
      )
    ).rows;
    if (resumed.length)
      await c.query(
        `UPDATE matching_work SET state='pending',error=NULL WHERE campaign_id=ANY($1::uuid[]) AND state='deferred'`,
        [resumed.map((r) => r.id)],
      );
    return resumed;
  });
  for (const row of rows)
    await logEvent(
      "info",
      "matching.campaign.resumed",
      "Matching resumed with a new monthly allowance",
      {
        campaign_id: row.id,
        reason: "new_calendar_month",
        timezone: settings.app.timezone,
      },
    );
}
export async function controlCampaign(
  action: "pause" | "resume",
  sourceId: string | null,
) {
  const result = await transaction(async (c) => {
    const campaigns = (
      await c.query<Campaign>(
        `UPDATE matching_campaigns SET state=$1,reason=$2 WHERE state=$3 AND ($4::uuid IS NULL OR source_id=$4) RETURNING *`,
        [
          action === "pause" ? "paused" : "running",
          action === "pause" ? "Paused by you" : "Resumed by you",
          action === "pause" ? "running" : "paused",
          sourceId,
        ],
      )
    ).rows;
    if (action === "resume" && campaigns.length)
      await c.query(
        `UPDATE matching_work SET state='pending',error=NULL WHERE campaign_id=ANY($1::uuid[]) AND state='deferred'`,
        [campaigns.map((r) => r.id)],
      );
    return campaigns;
  });
  for (const campaign of result)
    await logEvent(
      "info",
      action === "pause"
        ? "matching.campaign.paused"
        : "matching.campaign.resumed",
      action === "pause" ? "Matching paused by you" : "Matching resumed by you",
      {
        campaign_id: campaign.id,
        campaign_kind: campaign.kind,
        source_id: sourceId,
        reason: campaign.reason,
      },
    );
  return result;
}

export async function recordResult(
  query: StoreProduct,
  work: Work,
  comparisons: Comparison[],
  inputKey: string,
  fallbackReason: string,
  fallbackOutcome: Outcome = "no_candidates",
) {
  let details: Record<string, unknown> = {
    campaign_id: work.campaign_id,
    store_product_id: query.id,
    product_name: query.name,
    work_id: work.id,
    retailer: query.retailer,
  };
  let rejected = false;
  const result = await transaction(async (c) => {
    // Serialize only short graph commits. Network requests run before this lock.
    await assertProductAvailable(
      query.id,
      taskContext()?.task.options.source_id ?? null,
      c,
    );
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtext('store-product-group-commit'))`,
    );
    const current = (
      await c.query<StoreProduct>(
        `${productSelect} WHERE sp.id=$1 FOR UPDATE`,
        [query.id],
      )
    ).rows[0];
    const sourceActive = (
      await c.query(
        `SELECT 1 FROM store_products sp WHERE sp.id=$1 AND ${availableProductSql("sp")}`,
        [query.id],
      )
    ).rowCount;
    const owned = (
      await c.query(
        `SELECT 1 FROM matching_work WHERE id=$1 AND token=$2 FOR UPDATE`,
        [work.id, work.token],
      )
    ).rowCount;
    if (!owned) {
      details.reason = "Work claim changed";
      return { matched: false, stale: true };
    }
    const campaignRunning = (
      await c.query(
        `SELECT 1 FROM matching_campaigns WHERE id=$1 AND state='running'`,
        [work.campaign_id],
      )
    ).rowCount;
    let stale =
      current.version !== query.version ||
      current.group_id !== query.group_id ||
      current.group_version !== query.group_version ||
      !sourceActive ||
      !campaignRunning;
    const proposed = comparisons.filter((x) => x.outcome === "matched");
    const groupIds = [
      ...new Set([
        current.group_id,
        ...proposed.map((x) => x.candidate.product.group_id),
      ]),
    ].sort();
    const groups = (
      await c.query<{
        id: string;
        matching_version: number;
        matching_conflict: boolean;
      }>(
        `SELECT id,matching_version::int,matching_conflict FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [groupIds],
      )
    ).rows;
    for (const x of proposed) {
      await assertProductAvailable(x.candidate.product.id, null, c);
      const g = groups.find((g) => g.id === x.candidate.product.group_id);
      const members = await groupMembers(x.candidate.product.group_id, c);
      if (
        !g ||
        g.matching_version !== x.candidate.group_version ||
        g.matching_conflict ||
        hash(members.map((m) => [m.id, m.version]).sort()) !==
          hash(x.candidate.members.map((m) => [m.id, m.version]).sort())
      )
        stale = true;
    }
    const members = (
      await c.query<StoreProduct>(
        `${productSelect} WHERE sp.group_id=ANY($1::uuid[]) AND ${active} ORDER BY sp.id FOR UPDATE OF sp`,
        [groupIds],
      )
    ).rows;
    const humanLinks = await manualLinks(
      c,
      members.map((m) => m.id),
    );
    let problem = proposed.length
      ? groups.some((g) => g.matching_conflict)
        ? "Existing product group needs attention"
        : [...humanLinks.values()].includes("different")
          ? "These products were manually marked as different"
          : groupProblem(
              members.map(currentFacts),
              (a, b) => humanLinks.get(pairKey(a, b)) === "same",
            )
      : null;
    const aiGroups = new Set(
      proposed
        .filter((item) => item.method === "decision")
        .map((item) => item.candidate.product.group_id),
    );
    if (
      aiGroups.size &&
      !problem &&
      (current.classified_family == null ||
        !matchingConfig().ai_categories.includes(current.classified_family) ||
        members.some(
          (member) =>
            aiGroups.has(member.group_id) &&
            (member.classified_family == null ||
              !matchingConfig().ai_categories.includes(
                member.classified_family,
              )),
        ))
    )
      problem = "A proposed product category is not selected for AI matching";
    if (proposed.length && !problem) {
      // Detect a competing item before the first proposal wins by processing
      // order. This is source-identity validation, not within-chain AI matching.
      const competing = (
        await c.query(
          `SELECT 1 FROM store_products sp JOIN store_products member ON member.id=ANY($1::uuid[])
        WHERE sp.retailer=member.retailer AND sp.id<>ALL($1::uuid[]) AND ${active}
          AND ((member.local_key IS NOT NULL AND sp.local_key=member.local_key)
            OR (member.gtin IS NOT NULL AND sp.gtin=member.gtin) OR sp.normalized_name=member.normalized_name
            OR (member.facts->'brand'->>'value' IS NOT NULL AND sp.facts->'brand'->>'value'=member.facts->'brand'->>'value'
              AND (SELECT jsonb_object_agg(key,value->'value') FROM jsonb_each(sp.facts))=
                  (SELECT jsonb_object_agg(key,value->'value') FROM jsonb_each(member.facts)))) LIMIT 1`,
          [members.map((m) => m.id)],
        )
      ).rowCount;
      if (competing)
        problem =
          "Competing distinct products from the same store need attention";
    }
    const matched = proposed.length > 0 && !stale && !problem;
    let target = current.group_id;
    if (matched) {
      target = (
        await c.query<{ id: string }>(
          `SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY created_at,id LIMIT 1`,
          [groupIds],
        )
      ).rows[0].id;
      await c.query(
        `INSERT INTO product_membership_history(store_product_id,from_group_id,to_group_id)
        SELECT id,group_id,$2 FROM store_products WHERE group_id=ANY($1::uuid[]) AND group_id<>$2`,
        [groupIds, target],
      );
      await c.query(
        `UPDATE store_products SET group_id=$2,state='matched',last_reason='Same product across stores',updated_at=now() WHERE group_id=ANY($1::uuid[])`,
        [groupIds, target],
      );
      await c.query(
        `UPDATE products SET redirect_id=$2,matching_version=matching_version+1 WHERE id=ANY($1::uuid[]) AND id<>$2`,
        [groupIds, target],
      );
      await c.query(
        `UPDATE products SET matching_version=matching_version+1 WHERE id=$1`,
        [target],
      );
    }
    rejected = !!problem;
    details = {
      ...details,
      group_id: target,
      group_ids: groupIds,
      member_count: members.length,
      reason: matched
        ? "Same product across stores"
        : stale
          ? "Product or group changed before saving"
          : (problem ?? fallbackReason),
      expected_revision: query.version,
      current_revision: current.version,
      positive_proposals: proposed.length,
    };
    const outcomes = comparisons.length ? comparisons : [null];
    for (const comparison of outcomes) {
      const outcome = stale
        ? "stale"
        : problem && comparison?.outcome === "matched"
          ? "needs_info"
          : (comparison?.outcome ?? fallbackOutcome);
      await c.query(
        `INSERT INTO store_match_decisions(store_product_id,candidate_id,campaign_id,group_id,outcome,reason,input_key,source_version,evidence,model,probability,confidence,prompt_version,prompt_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          query.id,
          comparison?.candidate.product.id ?? null,
          work.campaign_id,
          matched ? target : null,
          outcome,
          stale
            ? "Product or group changed before saving"
            : (problem ?? comparison?.reason ?? fallbackReason),
          inputKey,
          query.version,
          {
            source: requestProduct(query),
            source_facts: query.facts,
            candidate: comparison
              ? requestProduct(comparison.candidate.product)
              : null,
            candidate_facts: comparison?.candidate.product.facts ?? null,
            retrieval: comparison?.candidate.reasons ?? [],
          },
          comparison?.method === "decision"
            ? matchingConfig().gateway.decision_model
            : null,
          comparison?.probability ?? null,
          comparison?.confidence ?? null,
          matchingConfig().prompt_version,
          comparison?.prompt_key ?? null,
        ],
      );
    }
    if (
      !matched &&
      !stale &&
      current.state !== "matched" &&
      current.state !== "legacy_conflict"
    ) {
      const deferred = comparisons.some((x) => x.outcome === "deferred");
      await c.query(
        `UPDATE store_products SET state=$2,last_reason=$3 WHERE id=$1`,
        [
          query.id,
          deferred
            ? "deferred"
            : fallbackOutcome === "category_excluded" && !problem
              ? "category_excluded"
              : problem
                ? "needs_info"
                : comparisons.length
                  ? "needs_info"
                  : fallbackOutcome,
          problem ?? fallbackReason,
        ],
      );
    }
    if (stale)
      await c.query(
        `UPDATE matching_work SET state='pending',token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND token=$2`,
        [work.id, work.token],
      );
    return { matched, stale };
  });
  await logEvent(
    result.stale ? "debug" : rejected ? "warn" : "debug",
    result.stale
      ? "matching.group.stale"
      : rejected
        ? "matching.group.rejected"
        : result.matched
          ? "matching.group.connected"
          : "matching.decision.saved",
    result.stale
      ? "Stale matching answer kept out of current groups"
      : rejected
        ? "Proposed product group failed compatibility checks"
        : result.matched
          ? "Products connected across stores"
          : "Matching decision saved",
    details,
  );
  return result;
}

export async function wakeNeighbors(product: StoreProduct) {
  if (taskContext()) return;
  // Indexed, bounded neighborhood changes; never reset every unresolved row.
  const candidates = await findCandidates(product);
  if (!candidates.length) return;
  const result = await pool.query(
    `WITH events AS (
    INSERT INTO matching_neighbor_events(source_product_id,target_product_id,change_key)
    SELECT $3,id,$2 FROM store_products WHERE id=ANY($1::uuid[]) AND state IN ('needs_info','no_candidates','deferred','different','category_excluded')
    ON CONFLICT DO NOTHING RETURNING target_product_id
  ) INSERT INTO matching_work(store_product_id,reason)
    SELECT target_product_id,'A useful new counterpart appeared' FROM events
    ON CONFLICT(store_product_id) DO UPDATE SET state='pending',campaign_id=NULL,reason=excluded.reason,updated_at=now()
      WHERE matching_work.state='completed'`,
    [
      candidates.map((c) => c.product.id),
      hash([product.fingerprint, product.facts, product.group_id]),
      product.id,
    ],
  );
  if (result.rowCount)
    await logEvent(
      "debug",
      "matching.neighbors.queued",
      "Affected unresolved products queued for reconsideration",
      {
        store_product_id: product.id,
        retailer: product.retailer,
        queued: result.rowCount,
      },
    );
}

export async function manuallySeparatedCandidates(
  query: StoreProduct,
  candidates: Candidate[],
) {
  return transaction(async (c) => {
    const members = await groupMembers(query.group_id, c);
    const links = await manualLinks(c, [
      ...members.map((p) => p.id),
      ...candidates.flatMap((g) => g.members.map((p) => p.id)),
    ]);
    return new Set(
      candidates
        .filter((candidate) =>
          candidate.members.some((b) =>
            members.some((a) => links.get(pairKey(a.id, b.id)) === "different"),
          ),
        )
        .map((g) => g.product.group_id),
    );
  });
}

export async function workRemaining(campaignId: string) {
  return !!(
    await pool.query(
      `SELECT 1 FROM matching_work WHERE campaign_id=$1 AND state IN ('pending','running') LIMIT 1`,
      [campaignId],
    )
  ).rowCount;
}
export async function campaignRunning(campaignId: string) {
  return !!(
    await pool.query(
      `SELECT 1 FROM matching_campaigns WHERE id=$1 AND state='running'`,
      [campaignId],
    )
  ).rowCount;
}
export async function recordDeferred(
  product: StoreProduct,
  work: Work,
  key: string,
  reason: string,
) {
  await transaction(async (c) => {
    if (
      !(
        await c.query(
          `SELECT 1 FROM matching_work WHERE id=$1 AND token=$2 FOR UPDATE`,
          [work.id, work.token],
        )
      ).rowCount
    )
      return;
    await c.query(
      `INSERT INTO store_match_decisions(store_product_id,campaign_id,outcome,reason,input_key,source_version,evidence,prompt_version) VALUES($1,$2,'deferred',$3,$4,$5,$6,$7)`,
      [
        product.id,
        work.campaign_id,
        reason,
        key,
        product.version,
        { source: requestProduct(product), source_facts: product.facts },
        matchingConfig().prompt_version,
      ],
    );
    await c.query(
      `UPDATE store_products SET state='deferred',last_reason=$2 WHERE id=$1 AND state NOT IN ('matched','legacy_conflict')`,
      [product.id, reason],
    );
  });
}
export async function releaseClaims(work: Work[]) {
  if (work.length) {
    const result = await pool.query(
      `UPDATE matching_work SET state='pending',token=NULL,lease_until=NULL WHERE state='running' AND (id,token) IN (SELECT id,token FROM jsonb_to_recordset($1::jsonb) AS claimed(id uuid,token uuid))`,
      [JSON.stringify(work.map((w) => ({ id: w.id, token: w.token })))],
    );
    if (result.rowCount)
      await logEvent(
        "debug",
        "matching.work.released",
        "Unfinished matching claims released",
        { released: result.rowCount, campaign_id: work[0].campaign_id },
      );
  }
}
export async function completeCampaign(campaignId: string) {
  const result = await pool.query(
    `UPDATE matching_campaigns SET state='completed',completed_at=now(),reason='Matching completed' WHERE id=$1 AND state='running'
    AND NOT EXISTS(SELECT 1 FROM matching_work w JOIN store_products sp ON sp.id=w.store_product_id WHERE w.campaign_id=$1 AND w.state<>'completed' AND ${availableProductSql("sp")})
    AND (kind<>'initial' OR NOT EXISTS(SELECT 1 FROM matching_work w JOIN store_products sp ON sp.id=w.store_product_id WHERE w.campaign_id IS NULL AND w.state='pending' AND ${availableProductSql("sp")}))`,
    [campaignId],
  );
  if (result.rowCount)
    await logEvent(
      "info",
      "matching.campaign.completed",
      "Matching campaign completed",
      { campaign_id: campaignId },
    );
}
export async function pauseDisabledCampaign(campaignId: string) {
  const result = await pool.query(
    `UPDATE matching_campaigns SET state='paused',paused_at=now(),reason='Gateway matching is disabled' WHERE id=$1 AND state='running'
  AND NOT EXISTS(SELECT 1 FROM matching_work WHERE campaign_id=$1 AND state IN ('pending','running'))
  AND EXISTS(SELECT 1 FROM matching_work WHERE campaign_id=$1 AND state='deferred')`,
    [campaignId],
  );
  if (result.rowCount)
    await logEvent(
      "warn",
      "matching.campaign.paused",
      "Matching paused because Gateway calls are disabled",
      { campaign_id: campaignId, reason: "gateway_disabled" },
    );
}

export async function matchingStatus(savedCoverage?: {
  counts: Record<string, number>;
  work_counts: Record<string, number>;
}) {
  const runtime = await readSettings();
  const [campaigns, coverage, state] = await Promise.all([
    pool.query(
      `SELECT c.*,coalesce(sum(u.cost_usd),0)::text AS spent_usd FROM matching_campaigns c LEFT JOIN ai_usage u ON u.campaign_id=c.id GROUP BY c.id ORDER BY c.created_at DESC LIMIT 20`,
    ),
    savedCoverage
      ? Promise.resolve({ rows: [savedCoverage] })
      : pool.query(
          `WITH visible AS MATERIALIZED (
        SELECT sp.id,sp.state FROM store_products sp WHERE ${active}
      ), product_counts AS (
        SELECT state,count(*)::int AS count FROM visible GROUP BY state
      ), work_counts AS (
        SELECT w.state,count(*)::int AS count FROM matching_work w JOIN visible sp ON sp.id=w.store_product_id GROUP BY w.state
      ) SELECT
        coalesce((SELECT jsonb_object_agg(state,count) FROM product_counts),'{}'::jsonb) AS counts,
        coalesce((SELECT jsonb_object_agg(state,count) FROM work_counts),'{}'::jsonb) AS work_counts`,
        ),
    pool.query(`SELECT * FROM matching_state WHERE key='store-products'`),
  ]);
  const monthly = (
    await pool.query(
      `SELECT coalesce(sum(u.cost_usd),0)::text AS spent FROM ai_usage u JOIN matching_campaigns c ON c.id=u.campaign_id WHERE c.kind='incremental' AND date_trunc('month',u.created_at AT TIME ZONE $1)=date_trunc('month',now() AT TIME ZONE $1)`,
      [settings.app.timezone],
    )
  ).rows[0].spent;
  return {
    automatic_enabled:
      runtime.policy.matching === "automatic" && !runtime.policy.paused,
    gateway_enabled: runtime.policy.ai_enabled,
    ai_categories: runtime.policy.ai_categories,
    indexing: state.rows[0],
    counts: coverage.rows[0].counts as Record<string, number>,
    work_counts: coverage.rows[0].work_counts as Record<string, number>,
    campaigns: campaigns.rows.map((c) => ({
      ...c,
      budget_usd:
        c.kind === "initial"
          ? runtime.policy.initial_budget_usd
          : c.kind === "evaluation"
            ? matchingConfig().gateway.evaluation_budget_usd
            : runtime.policy.monthly_budget_usd,
    })),
    monthly_spent_usd: monthly,
    monthly_budget_usd: runtime.policy.monthly_budget_usd,
  };
}
