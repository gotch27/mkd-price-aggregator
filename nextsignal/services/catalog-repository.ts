import { checkpoint, taskContext } from "./task-context";
import { logEvent, withLogContext } from "@/nextsignal/adapters/log-context";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { settings } from "@/nextsignal/config";
import { inputFingerprint } from "@/nextsignal/domain/matching";
import {
  descriptiveFingerprint,
  duplicateSummary,
  storeProductKey,
} from "@/nextsignal/domain/source-product-identity";
import type {
  CatalogPage,
  CatalogRow,
  DiscoveredSource,
  Run,
  Source,
} from "@/nextsignal/domain/types";
import { CatalogRestartRequired, SourceError } from "@/nextsignal/domain/types";
import { TaskPaused } from "@/nextsignal/domain/task-settings";
import {
  attributes,
  hash,
  identity,
  normalizeName,
} from "@/nextsignal/domain/normalize";
import { db, pool, transaction } from "./database";
import {
  preserveSourceProducts,
  synchronizeSource,
} from "@/nextsignal/services/matching-repository";
export async function seedRetailers() {
  for (const [slug, source] of Object.entries(settings.sources))
    await pool.query(
      `INSERT INTO retailers(slug,name,url,enabled,notice) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(slug) DO UPDATE SET name=$2,url=$3,enabled=$4,notice=$5`,
      [slug, source.name, source.url, source.enabled, source.notice],
    );
}

export async function getSource(id: string) {
  const row = (
    await pool.query<Source>("SELECT * FROM sources WHERE id=$1", [id])
  ).rows[0];
  if (!row) throw new Error("Source not found");
  return row;
}
export async function saveDiscovery(run: Run, sources: DiscoveredSource[]) {
  await transaction(async (c) => {
    for (const source of sources) {
      const { rows } = await c.query(
        "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(retailer,external_id) DO UPDATE SET name=$3,url=$4,scope=$5,meta=(sources.meta-'exclusion_reason')||$6::jsonb,availability_indexed_at=CASE WHEN sources.active THEN sources.availability_indexed_at ELSE NULL END,active=true,discovered_at=now() RETURNING id",
        [
          source.retailer,
          source.external_id,
          source.name,
          source.url,
          source.scope,
          source.meta,
        ],
      );
      if (!taskContext() || taskContext()!.task.kind === "import")
        await c.query(
          "INSERT INTO runs(kind,retailer,source_id,parent_id,status,checkpoint,task_id) VALUES('catalog',$1,$2,$3,'pending',$4,$5)",
          [
            run.retailer,
            rows[0].id,
            run.id,
            { source_url: source.url },
            run.task_id ?? null,
          ],
        );
    }
    await c.query(
      "UPDATE sources SET active=false WHERE retailer=$1 AND NOT(external_id=ANY($2::text[]))",
      [run.retailer, sources.map((s) => s.external_id)],
    );
    await c.query(
      "UPDATE runs SET status='success',finished_at=now(),summary=$2 WHERE id=$1",
      [run.id, { sources: sources.length }],
    );
    await c.query(
      "UPDATE catalog_browser_state SET requested_at=clock_timestamp() WHERE key='catalog'",
    );
  });
}
export async function stagePage(run: Run, page: CatalogPage) {
  await transaction(async (c) => {
    const timestamps = [
      ...new Set(
        page.rows
          .map((r) => r.source_updated_at)
          .filter((v): v is string => v !== null),
      ),
    ];
    if (timestamps.length > 1)
      throw new Error("Source timestamp is inconsistent within a page");
    if (
      settings.sources[run.retailer!].timestamp_policy === "snapshot" &&
      run.checkpoint.source_updated_at &&
      timestamps[0] &&
      run.checkpoint.source_updated_at !== timestamps[0]
    )
      throw new CatalogRestartRequired(
        "Source changed during retrieval; start a fresh catalog run",
      );
    if (
      run.checkpoint.total !== undefined &&
      run.checkpoint.total !== null &&
      page.total !== null &&
      run.checkpoint.total !== page.total
    )
      throw new CatalogRestartRequired(
        "Advertised product count changed during retrieval",
      );
    // Read only this page's counters. Large catalogs must not rewrite an ever-growing
    // map of every article identifier in their checkpoint after every page.
    const policy = settings.sources[run.retailer!].identity_policy;
    const counters =
      policy === "occurrence"
        ? await c.query(
            `SELECT data FROM staging
        WHERE run_id=$1 AND data->'raw'->>'identity_base'=ANY($2::text[])`,
            [run.id, page.rows.map((row) => row.key)],
          )
        : { rows: [] };
    const keyCounts: Record<string, number> = {};
    const descriptions = new Map<string, Set<string>>();
    for (const { data } of counters.rows as { data: CatalogRow }[]) {
      const base = String(data.raw.identity_base);
      keyCounts[base] = Math.max(
        keyCounts[base] ?? 0,
        Number(data.raw.identity_ordinal),
      );
      const known = descriptions.get(base) ?? new Set<string>();
      known.add(descriptiveFingerprint(data));
      descriptions.set(base, known);
    }
    const inputRows = page.rows.map((row) => {
      if (policy === "strict") return row;
      const count = (keyCounts[row.key] ?? 0) + 1;
      keyCounts[row.key] = count;
      const known = descriptions.get(row.key) ?? new Set<string>();
      known.add(descriptiveFingerprint(row));
      descriptions.set(row.key, known);
      return {
        ...row,
        key: `${row.key}:${count}`,
        raw: {
          ...row.raw,
          identity_base: row.key,
          identity_ordinal: count,
          identity_ambiguous: false,
        },
      };
    });
    const ambiguousBases = [...descriptions.entries()]
      .filter(([, fingerprints]) => fingerprints.size > 1)
      .map(([base]) => base);
    if (ambiguousBases.length) {
      const ambiguous = new Set(ambiguousBases);
      for (const row of inputRows)
        if (ambiguous.has(String(row.raw.identity_base)))
          row.raw.identity_ambiguous = true;
      await c.query(
        `UPDATE staging SET data=jsonb_set(data,'{raw,identity_ambiguous}','true'::jsonb,true)
         WHERE run_id=$1 AND data->'raw'->>'identity_base'=ANY($2::text[])
           AND data->'raw'->>'identity_ambiguous' IS DISTINCT FROM 'true'`,
        [run.id, ambiguousBases],
      );
    }
    const existing = await c.query(
      "SELECT key,data FROM staging WHERE run_id=$1 AND key=ANY($2::text[])",
      [run.id, inputRows.map((r) => r.key)],
    );
    const known = new Map(existing.rows.map((r) => [r.key, r.data]));
    const current = new Map<string, CatalogRow>();
    for (const row of inputRows) {
      const old = known.get(row.key) ?? current.get(row.key);
      if (old && hash(old) !== hash(row))
        throw new Error(`Conflicting duplicate source identifier: ${row.key}`);
      current.set(row.key, row);
    }
    await c.query(
      "INSERT INTO staging(run_id,key,data) SELECT $1,r->>'key',r FROM jsonb_array_elements($2::jsonb) r ON CONFLICT DO NOTHING",
      [run.id, JSON.stringify([...current.values()])],
    );
    const checkpoint: Run["checkpoint"] = {
      ...run.checkpoint,
      identity_policy: policy,
      cursor: page.next,
      done: page.next === null,
      total: page.total,
      source_updated_at:
        timestamps[0] ?? run.checkpoint.source_updated_at ?? null,
      pages_saved: Number(run.checkpoint.pages_saved ?? 0) + 1,
    };
    delete checkpoint.key_counts;
    await c.query(
      "UPDATE runs SET checkpoint=$2,retry_failures=0,last_progress_at=clock_timestamp() WHERE id=$1",
      [run.id, checkpoint],
    );
    run.checkpoint = checkpoint;
    run.retry_failures = 0;
    if (page.artifact !== null)
      await c.query(
        "INSERT INTO artifacts(source_id,run_id,content) VALUES($1,$2,$3) ON CONFLICT(source_id) DO UPDATE SET run_id=$2,content=$3,created_at=now()",
        [run.source_id, run.id, page.artifact],
      );
  });
}
export function shouldConfirm(count: number, previous: number, ratio: number) {
  return count === 0 || (previous > 0 && count < previous * ratio);
}
export async function publishCatalog(run: Run) {
  await checkpoint();
  return withLogContext(
    {
      data: {
        run_id: run.id,
        retailer: run.retailer,
        source_id: run.source_id,
      },
    },
    async () => {
      try {
        return await publishCatalogScoped(run);
      } catch (error) {
        if (error instanceof TaskPaused) {
          await logEvent(
            "info",
            "catalog.publication.paused",
            "Catalog save paused; downloaded pages are preserved",
          );
          throw error;
        }
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        if (
          [
            "40001",
            "40P01",
            "55P03",
            "57014",
            "08003",
            "08006",
            "57P01",
            "ECONNRESET",
            "ECONNREFUSED",
            "ETIMEDOUT",
          ].includes(code)
        ) {
          const retry = new SourceError(
            "Temporary database interruption while saving catalog prices",
            true,
          );
          retry.diagnostics = { phase: "publication", error_code: code };
          await logEvent(
            "warn",
            "catalog.publication.interrupted",
            "Catalog save interrupted; downloaded pages are preserved",
            { error_code: code },
            error,
          );
          throw retry;
        }
        await logEvent(
          "error",
          "catalog.publication.failed",
          "Catalog publication could not be completed",
          {},
          error,
        );
        throw error;
      }
    },
  );
}
async function publishCatalogScoped(run: Run) {
  const started = Date.now();
  let phaseStarted = started;
  const phaseDurations: Record<string, number> = {};
  function finishPhase(phase: string) {
    const now = Date.now();
    phaseDurations[phase] = now - phaseStarted;
    phaseStarted = now;
  }
  await logEvent(
    "info",
    "catalog.publication.started",
    "Preparing catalog prices for publication",
  );
  const event: { publication?: Record<string, unknown>; conflicts: number } = {
    conflicts: 0,
  };
  const result = await transaction(async (c) => {
    const publicationLock = (
      await c.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('catalog-publication',0)) AS acquired",
      )
    ).rows[0].acquired;
    if (!publicationLock) {
      await c.query(
        "UPDATE runs SET status='pending',next_attempt_at=now()+$2*interval '1 second' WHERE id=$1",
        [run.id, settings.queue.poll_seconds],
      );
      return { status: "deferred" };
    }
    const source = (
      await c.query("SELECT * FROM sources WHERE id=$1 FOR NO KEY UPDATE", [
        run.source_id,
      ])
    ).rows[0];
    if (!source.active) {
      await c.query(
        "UPDATE runs SET status='superseded',finished_at=now(),summary=$2 WHERE id=$1",
        [run.id, { reason: "Catalog no longer offered by this supermarket" }],
      );
      return { status: "superseded" };
    }
    if (source.published_run === run.id) {
      await c.query("UPDATE runs SET status='success',error=NULL WHERE id=$1", [
        run.id,
      ]);
      return { status: "success", published: source.row_count };
    }
    const published = source.published_run
      ? (
          await c.query(
            `SELECT coalesce((published.checkpoint->>'snapshot_started_at')::timestamptz,published.created_at)
              >coalesce((current.checkpoint->>'snapshot_started_at')::timestamptz,current.created_at) AS newer
              FROM runs published JOIN runs current ON current.id=$2 WHERE published.id=$1`,
            [source.published_run, run.id],
          )
        ).rows[0]
      : null;
    if (published?.newer) {
      await c.query(
        "UPDATE runs SET status='superseded',finished_at=now() WHERE id=$1",
        [run.id],
      );
      return { status: "superseded" };
    }
    const staged = (
      await c.query<{ data: CatalogRow }>(
        "SELECT data FROM staging WHERE run_id=$1 ORDER BY key",
        [run.id],
      )
    ).rows.map((r) => r.data);
    if (run.checkpoint.done !== true)
      throw new Error("Refusing to publish an incomplete catalog");
    if (
      run.checkpoint.total !== null &&
      Number(run.checkpoint.total) !== staged.length
    )
      throw new Error(
        `Catalog count mismatch: expected ${run.checkpoint.total}, parsed ${staged.length}`,
      );
    if (
      shouldConfirm(
        staged.length,
        source.row_count,
        settings.ingestion.reduction_ratio,
      )
    ) {
      const prior = run.checkpoint.confirmation_of as string | undefined;
      const confirmed = prior
        ? (
            await c.query(
              "SELECT count(*) AS n FROM ((SELECT key,data-'source_updated_at' AS data FROM staging WHERE run_id=$1 EXCEPT SELECT key,data-'source_updated_at' FROM staging WHERE run_id=$2) UNION ALL (SELECT key,data-'source_updated_at' FROM staging WHERE run_id=$2 EXCEPT SELECT key,data-'source_updated_at' FROM staging WHERE run_id=$1)) diff",
              [run.id, prior],
            )
          ).rows[0].n === "0"
        : false;
      if (!confirmed) {
        await c.query(
          "UPDATE runs SET status='quarantined',finished_at=now(),summary=$2 WHERE id=$1",
          [
            run.id,
            {
              parsed: staged.length,
              previous: source.row_count,
              reason: "Requires identical confirming retrieval",
            },
          ],
        );
        if (!prior)
          await c.query(
            "INSERT INTO runs(kind,retailer,source_id,parent_id,status,checkpoint,task_id) VALUES('catalog',$1,$2,$3,'pending',$4,$5)",
            [
              run.retailer,
              run.source_id,
              run.parent_id,
              {
                confirmation_of: run.id,
                source_url: run.checkpoint.source_url,
                source_restarts: run.checkpoint.source_restarts ?? 0,
              },
              run.task_id ?? null,
            ],
          );
        return { status: "quarantined" };
      }
    }
    if (typeof run.checkpoint.source_url !== "string")
      throw new Error("Catalog source provenance is required");
    const old = (
      await c.query(
        "SELECT id,external_key,identity_hash,product_id,normalized_name,attributes FROM listings WHERE retailer=$1 AND namespace=$2 ORDER BY id FOR UPDATE",
        [run.retailer, source.external_id],
      )
    ).rows;
    finishPhase("validation");
    // Capture unindexed legacy revisions before a live import can replace their
    // descriptive fields. This also preserves products without current offers.
    const preserved = await preserveSourceProducts(c, run.source_id!);
    finishPhase("preserve_product_memory");
    const byKey = new Map(old.map((r) => [r.external_key, r]));
    const newIdentities = staged
      .filter(
        (row) =>
          byKey.get(row.key)?.identity_hash !== identity(row) ||
          Number(row.raw.identity_ordinal) > 1,
      )
      .map((row) => ({
        external_key: storeProductKey(
          row.key,
          typeof row.raw.identity_base === "string"
            ? row.raw.identity_base
            : null,
        ),
        fingerprint: inputFingerprint({
          ...row,
          ambiguous: row.raw.identity_ambiguous === true,
        }),
      }));
    const canonicalGroups = newIdentities.length
      ? (
          await c.query<{
            external_key: string;
            fingerprint: string;
            group_id: string;
          }>(
            `SELECT sp.external_key,sp.fingerprint,sp.group_id FROM store_products sp
       JOIN jsonb_to_recordset($2::jsonb) AS incoming(external_key text,fingerprint text)
         ON sp.external_key=incoming.external_key AND sp.fingerprint=incoming.fingerprint
       WHERE sp.retailer=$1`,
            [run.retailer, JSON.stringify(newIdentities)],
          )
        ).rows
      : [];
    const groupByIdentity = new Map(
      canonicalGroups.map((p) => [
        `${p.external_key}:${p.fingerprint}`,
        p.group_id,
      ]),
    );
    const prepared = staged.map((row) => {
      const previous = byKey.get(row.key);
      const fingerprint = identity(row);
      const unchanged = previous?.identity_hash === fingerprint;
      const parsedAttributes = unchanged
        ? previous.attributes
        : attributes(row);
      const productKey = `${storeProductKey(row.key, typeof row.raw.identity_base === "string" ? row.raw.identity_base : null)}:${inputFingerprint({ ...row, ambiguous: false })}`;
      const savedGroup =
        groupByIdentity.get(productKey) ??
        (unchanged ? previous.product_id : undefined);
      const productId = savedGroup ?? randomUUID();
      groupByIdentity.set(productKey, productId);
      return {
        ...row,
        id: previous?.id ?? randomUUID(),
        product_id: productId,
        create_product: savedGroup == null,
        identity_hash: fingerprint,
        normalized_name: unchanged
          ? previous.normalized_name
          : normalizeName(row.name),
        attributes: {
          ...parsedAttributes,
          ambiguous:
            parsedAttributes.ambiguous || row.raw.identity_ambiguous === true,
        },
      };
    });
    const encoded = JSON.stringify(prepared);
    await c.query(
      "INSERT INTO products(id,name,normalized_name,attributes) SELECT (r->>'product_id')::uuid,r->>'name',r->>'normalized_name',r->'attributes' FROM jsonb_array_elements($1::jsonb) r WHERE (r->>'create_product')::boolean ON CONFLICT DO NOTHING",
      [encoded],
    );
    finishPhase("prepare_products");
    // Preserve the live assignment for unchanged identities. A matcher may have
    // committed a connection after the preparation query above read this listing.
    await c.query(
      `INSERT INTO listings (
         id, retailer, namespace, external_key, name, description, category,
         gtin, raw, identity_hash, normalized_name, attributes, product_id, match_status
       )
       SELECT (r->>'id')::uuid, $2, $3, r->>'key', r->>'name', r->>'description',
         r->>'category', r->>'gtin', r->'raw', r->>'identity_hash',
         r->>'normalized_name', r->'attributes', (r->>'product_id')::uuid, 'separate'
       FROM jsonb_array_elements($1::jsonb) r
       ON CONFLICT (retailer, namespace, external_key) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         category = excluded.category,
         gtin = excluded.gtin,
         raw = excluded.raw,
         normalized_name = excluded.normalized_name,
         attributes = CASE WHEN listings.identity_hash = excluded.identity_hash
           THEN listings.attributes ELSE excluded.attributes END,
         product_id = CASE WHEN listings.identity_hash = excluded.identity_hash
           THEN listings.product_id ELSE excluded.product_id END,
         match_status = CASE WHEN listings.identity_hash = excluded.identity_hash
           THEN listings.match_status ELSE 'separate' END,
         next_match_at = CASE WHEN listings.identity_hash = excluded.identity_hash
           THEN listings.next_match_at ELSE now() END,
         identity_hash = excluded.identity_hash,
         updated_at = now()
       WHERE (listings.name,listings.description,listings.category,listings.gtin,listings.raw,listings.normalized_name,listings.identity_hash)
         IS DISTINCT FROM (excluded.name,excluded.description,excluded.category,excluded.gtin,excluded.raw,excluded.normalized_name,excluded.identity_hash)`,
      [encoded, run.retailer, source.external_id],
    );
    finishPhase("store_records");
    const removedOffers = await c.query(
      "DELETE FROM offers WHERE source_id=$1 AND listing_id NOT IN(SELECT unnest($2::uuid[]))",
      [run.source_id, prepared.map((r) => r.id)],
    );
    await c.query(
      `INSERT INTO offers (
         source_id, listing_id, price, regular_price, promo_price, unit_price,
         available, promotion, source_updated_at, retrieved_at, run_id, source_url
       )
       SELECT $2, (r->>'id')::uuid, (r->>'price')::numeric,
         (r->>'regular_price')::numeric, (r->>'promo_price')::numeric,
         r->>'unit_price', (r->>'available')::boolean, r->>'promotion',
         (r->>'source_updated_at')::timestamptz, now(), $3, $4
       FROM jsonb_array_elements($1::jsonb) r
       ON CONFLICT(source_id,listing_id) DO UPDATE SET
         price=excluded.price,regular_price=excluded.regular_price,promo_price=excluded.promo_price,
         unit_price=excluded.unit_price,available=excluded.available,promotion=excluded.promotion,
         source_updated_at=excluded.source_updated_at,retrieved_at=excluded.retrieved_at,
         run_id=excluded.run_id,source_url=excluded.source_url`,
      [encoded, run.source_id, run.id, run.checkpoint.source_url],
    );
    finishPhase("branch_prices");
    await c.query(
      "UPDATE sources SET published_run=$2,published_at=now(),last_success=now(),row_count=$3 WHERE id=$1",
      [run.source_id, run.id, staged.length],
    );
    await c.query(
      "UPDATE runs SET status='success',finished_at=now(),summary=$2 WHERE id=$1",
      [
        run.id,
        {
          published: staged.length,
          unknown_prices: staged.filter((r) => r.price === null).length,
        },
      ],
    );
    await logEvent(
      "info",
      "catalog.publication.indexing",
      "Checking product information before publishing prices",
      { products: staged.length },
    );
    const changes = await synchronizeSource(c, run.source_id!);
    finishPhase("product_indexing");
    event.publication = {
      previous_offers: source.row_count,
      published_offers: staged.length,
      ...changes,
      legacy_observations_preserved: preserved.observations,
      phase_durations_ms: phaseDurations,
      removed_offers: removedOffers.rowCount,
      ...duplicateSummary(staged),
    };
    event.conflicts =
      changes.branch_conflicts_opened + changes.legacy_conflict_records;
    await c.query(
      "UPDATE catalog_browser_state SET requested_at=clock_timestamp() WHERE key='catalog'",
    );
    return { status: "success", published: staged.length };
  });
  if (event.publication) {
    await logEvent(
      "info",
      "catalog.publication.completed",
      "Catalog prices and matching changes published",
      { ...event.publication, duration_ms: Date.now() - started },
    );
    if (event.conflicts)
      await logEvent(
        "warn",
        "catalog.publication.conflicts",
        "Published source contains product information conflicts",
        { conflict_records: event.conflicts },
      );
    if (Number(event.publication.repeated_product_rows) > 0)
      await logEvent(
        "info",
        "catalog.duplicates.collapsed",
        "Repeated source rows combined into unique store products",
        event.publication,
      );
    if (Number(event.publication.price_conflicts) > 0)
      await logEvent(
        "warn",
        "catalog.prices.conflicting",
        "Store published different prices for the same product in one catalog; all observations retained",
        { price_conflicts: event.publication.price_conflicts },
      );
  } else if (result.status === "quarantined")
    await logEvent(
      "warn",
      "catalog.publication.quarantined",
      "Catalog replacement requires a confirming retrieval",
      { status: result.status },
    );
  else
    await logEvent(
      "debug",
      "catalog.publication.skipped",
      "Catalog publication skipped",
      { status: result.status },
    );
  return result;
}
export async function dashboardSummary() {
  const result = await db.execute(
    sql`SELECT r.*, (SELECT count(*)::int FROM sources s WHERE s.retailer=r.slug AND s.active) AS sources,(SELECT count(*)::int FROM sources s WHERE s.retailer=r.slug AND s.active AND s.last_success IS NOT NULL) AS imported,(SELECT count(*)::int FROM sources s WHERE s.retailer=r.slug AND s.active AND s.last_success>=now()-${settings.ingestion.freshness_hours}*interval '1 hour') AS fresh,(SELECT coalesce(sum(row_count),0)::int FROM sources s WHERE s.retailer=r.slug AND s.active) AS offers,(SELECT max(last_success) FROM sources s WHERE s.retailer=r.slug) AS last_success FROM retailers r ORDER BY name`,
  );
  return result.rows;
}
