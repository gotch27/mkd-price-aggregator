import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { settings } from "@/nextsignal/config";
import type {
  CatalogPage,
  CatalogRow,
  DiscoveredSource,
  Run,
  Source,
} from "@/nextsignal/domain/types";
import { CatalogRestartRequired } from "@/nextsignal/domain/types";
import {
  attributes,
  hash,
  identity,
  normalizeName,
} from "@/nextsignal/domain/normalize";
import { db, pool, transaction } from "./database";
export async function seedRetailers() {
  for (const [slug, c] of Object.entries(settings.sources)) {
    const expression = c.cron === null ? settings.scheduler.cron : c.cron;
    await pool.query(
      `INSERT INTO retailers(slug,name,url,enabled,notice,schedule_expression,schedule_timezone) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(slug) DO UPDATE SET name=$2,url=$3,enabled=$4,notice=$5,next_due=CASE WHEN retailers.schedule_expression IS DISTINCT FROM $6 OR retailers.schedule_timezone IS DISTINCT FROM $7 THEN NULL ELSE retailers.next_due END,schedule_expression=$6,schedule_timezone=$7`,
      [
        slug,
        c.name,
        c.url,
        c.enabled,
        c.notice,
        expression,
        settings.app.timezone,
      ],
    );
  }
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
        "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(retailer,external_id) DO UPDATE SET name=$3,url=$4,scope=$5,meta=$6,active=true,discovered_at=now() RETURNING id",
        [
          source.retailer,
          source.external_id,
          source.name,
          source.url,
          source.scope,
          source.meta,
        ],
      );
      await c.query(
        "INSERT INTO runs(kind,retailer,source_id,parent_id,status,checkpoint) VALUES('catalog',$1,$2,$3,'pending',$4)",
        [run.retailer, rows[0].id, run.id, { source_url: source.url }],
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
            `SELECT data->'raw'->>'identity_base' AS base,
        max((data->'raw'->>'identity_ordinal')::integer) AS ordinal FROM staging
        WHERE run_id=$1 AND data->'raw'->>'identity_base'=ANY($2::text[])
        GROUP BY data->'raw'->>'identity_base'`,
            [run.id, page.rows.map((row) => row.key)],
          )
        : { rows: [] };
    const keyCounts: Record<string, number> = Object.fromEntries(
      counters.rows.map((row) => [row.base, row.ordinal]),
    );
    const inputRows = page.rows.map((row) => {
      if (policy === "strict") return row;
      const count = (keyCounts[row.key] ?? 0) + 1;
      keyCounts[row.key] = count;
      return {
        ...row,
        key: `${row.key}:${count}`,
        raw: {
          ...row.raw,
          identity_base: row.key,
          identity_ordinal: count,
          identity_ambiguous: count > 1,
        },
      };
    });
    for (const row of inputRows)
      if (row.raw.identity_ambiguous) {
        const base = row.raw.identity_base;
        for (const other of inputRows)
          if (other.raw.identity_base === base)
            other.raw.identity_ambiguous = true;
        await c.query(
          "UPDATE staging SET data=jsonb_set(data,'{raw,identity_ambiguous}','true'::jsonb,true) WHERE run_id=$1 AND data->'raw'->>'identity_base'=$2",
          [run.id, base],
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
    };
    delete checkpoint.key_counts;
    await c.query("UPDATE runs SET checkpoint=$2 WHERE id=$1", [
      run.id,
      checkpoint,
    ]);
    run.checkpoint = checkpoint;
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
  return transaction(async (c) => {
    const source = (
      await c.query("SELECT * FROM sources WHERE id=$1 FOR UPDATE", [
        run.source_id,
      ])
    ).rows[0];
    if (source.published_run === run.id) {
      await c.query("UPDATE runs SET status='success',error=NULL WHERE id=$1", [
        run.id,
      ]);
      return { status: "success", published: source.row_count };
    }
    const published = source.published_run
      ? (
          await c.query(
            "SELECT published.created_at>current.created_at AS newer FROM runs published JOIN runs current ON current.id=$2 WHERE published.id=$1",
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
            "INSERT INTO runs(kind,retailer,source_id,parent_id,status,checkpoint) VALUES('catalog',$1,$2,$3,'pending',$4)",
            [
              run.retailer,
              run.source_id,
              run.parent_id,
              {
                confirmation_of: run.id,
                source_url: run.checkpoint.source_url,
                source_restarts: run.checkpoint.source_restarts ?? 0,
              },
            ],
          );
        return { status: "quarantined" };
      }
    }
    if (typeof run.checkpoint.source_url !== "string")
      throw new Error("Catalog source provenance is required");
    const old = (
      await c.query(
        "SELECT id,external_key,identity_hash,product_id FROM listings WHERE retailer=$1 AND namespace=$2",
        [run.retailer, source.external_id],
      )
    ).rows;
    const byKey = new Map(old.map((r) => [r.external_key, r]));
    const prepared = staged.map((row) => {
      const previous = byKey.get(row.key);
      const fingerprint = identity(row);
      const parsedAttributes = attributes(row);
      return {
        ...row,
        id: previous?.id ?? randomUUID(),
        product_id:
          previous?.identity_hash === fingerprint
            ? previous.product_id
            : randomUUID(),
        identity_hash: fingerprint,
        normalized_name: normalizeName(row.name),
        attributes: {
          ...parsedAttributes,
          ambiguous:
            parsedAttributes.ambiguous || row.raw.identity_ambiguous === true,
        },
      };
    });
    const encoded = JSON.stringify(prepared);
    await c.query(
      "INSERT INTO products(id,name,normalized_name,attributes) SELECT (r->>'product_id')::uuid,r->>'name',r->>'normalized_name',r->'attributes' FROM jsonb_array_elements($1::jsonb) r ON CONFLICT DO NOTHING",
      [encoded],
    );
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
         updated_at = now()`,
      [encoded, run.retailer, source.external_id],
    );
    await c.query("DELETE FROM offers WHERE source_id=$1", [run.source_id]);
    await c.query(
      `INSERT INTO offers (
         source_id, listing_id, price, regular_price, promo_price, unit_price,
         available, promotion, source_updated_at, retrieved_at, run_id, source_url
       )
       SELECT $2, (r->>'id')::uuid, (r->>'price')::numeric,
         (r->>'regular_price')::numeric, (r->>'promo_price')::numeric,
         r->>'unit_price', (r->>'available')::boolean, r->>'promotion',
         (r->>'source_updated_at')::timestamptz, now(), $3, $4
       FROM jsonb_array_elements($1::jsonb) r`,
      [encoded, run.source_id, run.id, run.checkpoint.source_url],
    );
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
    if (settings.matching.enabled)
      await c.query(
        "INSERT INTO runs(kind,retailer,source_id,parent_id,status) VALUES('match',$1,$2,$3,'pending')",
        [run.retailer, run.source_id, run.id],
      );
    await c.query(
      "UPDATE catalog_browser_state SET requested_at=clock_timestamp() WHERE key='catalog'",
    );
    return { status: "success", published: staged.length };
  });
}
export async function dashboardSummary() {
  const result = await db.execute(
    sql`SELECT r.*, (SELECT count(*)::int FROM sources s WHERE s.retailer=r.slug AND s.active) AS sources,(SELECT count(*)::int FROM sources s WHERE s.retailer=r.slug AND s.active AND s.last_success IS NOT NULL) AS imported,(SELECT count(*)::int FROM sources s WHERE s.retailer=r.slug AND s.active AND s.last_success>=now()-${settings.ingestion.freshness_hours}*interval '1 hour') AS fresh,(SELECT coalesce(sum(row_count),0)::int FROM sources s WHERE s.retailer=r.slug AND s.active) AS offers,(SELECT max(last_success) FROM sources s WHERE s.retailer=r.slug) AS last_success FROM retailers r ORDER BY name`,
  );
  return result.rows;
}
