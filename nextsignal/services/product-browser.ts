import type {
  DashboardPage,
  DashboardQuery,
  ProductDetail,
} from "@/nextsignal/domain/dashboard";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import { browserStatus } from "@/nextsignal/services/catalog-browser";
import { normalizeName } from "@/nextsignal/domain/normalize";
import { expandNameSearch } from "@/nextsignal/domain/local-matching";
import { classificationViews } from "@/nextsignal/services/product-categories";
import {
  availabilitySql,
  availabilityMap,
  availableIdentitySql,
} from "./product-availability";

// Group the compact browser index, rather than scanning every branch offer.
// Filters select whole products; the returned stores and prices describe the
// entire group, including stores whose original names differ from the search.
export async function readUniversalProducts(
  input: DashboardQuery,
): Promise<DashboardPage> {
  const values: unknown[] = [];
  const predicates: string[] = [];
  const search = normalizeName(input.search);
  if (search) {
    values.push(
      expandNameSearch(input.search, settings.matching.local).map(
        (term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`,
      ),
    );
    predicates.push(
      `bool_or(b.normalized_name ILIKE ANY($${values.length}::text[]))`,
    );
  }
  if (input.retailer) {
    values.push(input.retailer);
    predicates.push(`bool_or(b.retailer=$${values.length})`);
  }
  const availability =
    input.availability ?? settings.dashboard.product_availability;
  if (availability === "available") {
    predicates.push(
      `bool_or((${input.retailer ? `b.retailer=$${values.length} AND ` : ""}${availableIdentitySql("b.store_product_id")}))`,
    );
  } else if (availability !== "all") {
    values.push(availability);
    predicates.push(
      `bool_or((${input.retailer ? "b.retailer=$" + (values.length - 1) + " AND " : ""}${availabilitySql("b.store_product_id")}=$${values.length}))`,
    );
  }
  const quality = input.name_quality ?? settings.dashboard.product_name_quality;
  if (quality !== "all")
    predicates.push(
      quality === "named"
        ? "bool_or(b.usable_name)"
        : "NOT bool_or(b.usable_name)",
    );
  if (input.match_filter === "matched")
    predicates.push("count(DISTINCT b.retailer)>1");
  if (input.match_filter === "unmatched")
    predicates.push("count(DISTINCT b.retailer)=1");
  const grouped = `SELECT b.product_id AS id,min(b.name) AS name
    FROM store_product_identity_browser b
    GROUP BY b.product_id ${predicates.length ? `HAVING ${predicates.join(" AND ")}` : ""}`;
  const size = Math.min(input.size, settings.dashboard.max_page_size);
  const sizeParam = `$${values.length + 1}`;
  const pageParam = `$${values.length + 2}`;
  // Materialize groups once for both exact totals and paging. Only aggregate
  // prices and store badges for this page, rather than every product group.
  const [result, status] = await Promise.all([
    pool.query(
      `WITH groups AS MATERIALIZED (${grouped}),
      totals AS (SELECT count(*)::int AS total FROM groups),
      selected AS (SELECT * FROM groups ORDER BY name,id LIMIT ${sizeParam}
        OFFSET (SELECT (LEAST(${pageParam}::numeric,GREATEST(ceil(total::numeric/${sizeParam})::int,1))::int-1)*${sizeParam} FROM totals))
      SELECT totals.total,selected.id,selected.id AS product_id,selected.name,details.*
      FROM totals LEFT JOIN selected ON true
      LEFT JOIN LATERAL (
        SELECT min(b.category) AS category,coalesce(min(b.price) FILTER(WHERE ${availabilitySql("b.store_product_id")}='available'),min(b.price)) AS price,
          (array_agg(b.retailer ORDER BY b.name,b.retailer))[1] AS name_retailer,
          coalesce(max(b.highest_price) FILTER(WHERE ${availabilitySql("b.store_product_id")}='available'),max(b.highest_price)) AS highest_price,
          count(*)::int AS listing_count,count(DISTINCT b.retailer)::int AS connected_retailers,
          array_agg(DISTINCT b.retailer ORDER BY b.retailer) AS retailers,max(b.retrieved_at) AS retrieved_at
          ,bool_or(b.matching_state='legacy_conflict' OR b.matching_reason='Branches disagree about this store article') AS group_needs_attention,
          CASE WHEN bool_or(${availabilitySql("b.store_product_id")}='available') THEN 'available' WHEN bool_or(${availabilitySql("b.store_product_id")}='unknown') THEN 'unknown' ELSE 'unavailable' END AS availability
        FROM store_product_browser b WHERE b.product_id=selected.id
      ) details ON selected.id IS NOT NULL ORDER BY selected.name,selected.id`,
      [...values, size, input.page],
    ),
    browserStatus(),
  ]);
  const total: number = result.rows[0].total;
  const totalPages = Math.ceil(total / size);
  const page = Math.min(input.page, Math.max(1, totalPages));
  const rows = result.rows
    .filter((r) => r.id !== null)
    .map(({ total: _total, ...row }) => row);
  return {
    view: "universal",
    rows,
    page,
    page_size: size,
    total,
    total_pages: totalPages,
    refreshed_at: status.completed_at.toISOString(),
    refresh_pending: status.dirty,
  };
}

export async function detailsForProduct(
  id: string,
): Promise<ProductDetail | null> {
  const product = (
    await pool.query(
      `WITH RECURSIVE chain AS (
    SELECT * FROM products WHERE id=$1
    UNION SELECT p.* FROM products p JOIN chain c ON p.id=c.redirect_id
  ) SELECT * FROM chain WHERE redirect_id IS NULL`,
      [id],
    )
  ).rows[0];
  if (!product) return null;
  const [listings, offers, decisions] = await Promise.all([
    pool.query(
      `SELECT b.*,l.id,b.product_id,b.matching_state AS match_status,
      CASE WHEN sp.id IS NULL THEN l.attributes ELSE (SELECT coalesce(jsonb_object_agg(key,value->'value'),'{}'::jsonb) FROM jsonb_each(sp.facts)) END AS attributes,
      sp.facts AS supported_facts,sp.manual_facts AS manual_attributes,sp.branch_conflict,l.gtin,l.description,
      EXISTS(SELECT 1 FROM store_product_sources ss JOIN sources source ON source.id=ss.source_id AND source.active WHERE ss.store_product_id=sp.id AND ss.price_conflict) AS price_conflict
      FROM store_product_browser b JOIN listings l ON l.id=b.listing_id
      LEFT JOIN store_products sp ON sp.id=b.store_product_id
      WHERE b.product_id=$1 ORDER BY b.retailer,b.name,l.id`,
      [product.id],
    ),
    offersForProduct(product.id),
    pool.query(
      `SELECT d.*,l.name,l.retailer,
      d.identity_hash=l.identity_hash AS current_identity
      FROM match_decisions d JOIN listings l ON l.id=d.listing_id
      WHERE l.product_id=$1 OR EXISTS(
        SELECT 1 FROM store_product_observations observation JOIN store_products sp ON sp.id=observation.store_product_id
        WHERE observation.listing_id=l.id AND sp.group_id=$1
      ) ORDER BY d.created_at DESC,d.id DESC
      LIMIT $2`,
      [product.id, settings.dashboard.max_page_size],
    ),
  ]);
  const savedProducts = (
    await pool.query(
      `SELECT sp.*,sp.group_id AS product_id,sp.state AS match_status,sp.last_reason AS matching_reason,
    0 AS catalog_count,NULL::numeric AS price,NULL::numeric AS highest_price,sp.facts AS supported_facts,sp.manual_facts AS manual_attributes,
    (SELECT coalesce(jsonb_object_agg(key,value->'value'),'{}'::jsonb) FROM jsonb_each(sp.facts)) AS attributes
    FROM store_products sp WHERE sp.group_id=$1
      AND NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id)
      AND NOT EXISTS(
      SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active WHERE ss.store_product_id=sp.id
    ) ORDER BY sp.retailer,sp.name`,
      [product.id],
    )
  ).rows;
  const visibleProducts = [...listings.rows, ...savedProducts];
  const categoryByProduct = await classificationViews(
    visibleProducts.map((row) => row.store_product_id ?? row.id),
  );
  const availabilityByProduct = await availabilityMap(
    visibleProducts.map((row) => row.store_product_id ?? row.id),
  );
  for (const row of visibleProducts) {
    row.classification = categoryByProduct.get(row.store_product_id ?? row.id);
    row.availability =
      availabilityByProduct.get(row.store_product_id ?? row.id) ?? "unknown";
  }
  product.matching_conflict =
    product.matching_conflict ||
    visibleProducts.some((p) => p.branch_conflict === true);
  const currentDecisions = (
    await pool.query(
      `SELECT d.*,sp.name,sp.retailer,d.group_id AS product_id,d.outcome AS method,d.evidence->>'note' AS note,d.evidence->>'actor' AS actor,
    d.source_version=sp.version AS current_identity,
    CASE WHEN d.candidate_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('candidate_name',candidate.name,'candidate_retailer',candidate.retailer,'reason',d.reason,'probability',d.probability,'method',d.outcome)) END AS candidates
    FROM store_match_decisions d JOIN store_products sp ON sp.id=d.store_product_id
    LEFT JOIN store_products candidate ON candidate.id=d.candidate_id
    WHERE sp.group_id=$1 OR candidate.group_id=$1 ORDER BY d.created_at DESC,d.id DESC LIMIT $2`,
      [product.id, settings.dashboard.max_page_size],
    )
  ).rows;
  for (const decision of decisions.rows) {
    decision.candidates = Array.isArray(decision.evidence)
      ? decision.evidence
      : Array.isArray(decision.evidence?.candidates)
        ? decision.evidence.candidates
        : [];
    decision.deferred = decision.evidence?.deferred === true;
  }
  const candidateIds = decisions.rows.flatMap((d) =>
    d.candidates.flatMap((e: { candidate?: unknown }) =>
      typeof e.candidate === "string" && /^[0-9a-f-]{36}$/i.test(e.candidate)
        ? [e.candidate]
        : [],
    ),
  );
  const candidates = candidateIds.length
    ? (
        await pool.query(
          "SELECT id,name,retailer FROM listings WHERE id=ANY($1::uuid[])",
          [candidateIds],
        )
      ).rows
    : [];
  const byId = new Map(candidates.map((c) => [c.id, c]));
  for (const decision of decisions.rows) {
    if (Array.isArray(decision.candidates))
      decision.candidates = decision.candidates.map(
        (e: { candidate?: string }) => ({
          ...e,
          candidate_name: byId.get(e.candidate)?.name,
          candidate_retailer: byId.get(e.candidate)?.retailer,
        }),
      );
  }
  return {
    product,
    listings: visibleProducts,
    offers,
    decisions: [...currentDecisions, ...decisions.rows]
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      .slice(0, settings.dashboard.max_page_size),
  };
}

export async function offersForProduct(id: string) {
  return (
    await pool.query(
      `WITH RECURSIVE chain AS (
    SELECT id,redirect_id FROM products WHERE id=$1
    UNION SELECT p.id,p.redirect_id FROM products p JOIN chain c ON p.id=c.redirect_id
  ), members AS (
    SELECT a.listing_id AS id,sp.id AS store_product_id FROM store_products sp JOIN store_product_aliases a ON a.store_product_id=sp.id
    WHERE sp.group_id=(SELECT id FROM chain WHERE redirect_id IS NULL)
    UNION
    SELECT l.id,NULL::uuid FROM listings l WHERE l.product_id=(SELECT id FROM chain WHERE redirect_id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM store_product_aliases a WHERE a.listing_id=l.id)
  ), observations AS (
    SELECT l.name,l.retailer,s.name AS branch,s.scope,o.*,coalesce(ss.price_conflict,false) AS price_conflict,
      count(*) OVER duplicates AS repeated_rows,row_number() OVER (duplicates ORDER BY l.id) AS duplicate_position
    FROM members
    JOIN listings l ON l.id=members.id JOIN offers o ON o.listing_id=l.id
    JOIN sources s ON s.id=o.source_id AND s.active
    LEFT JOIN store_product_sources ss ON ss.store_product_id=members.store_product_id AND ss.source_id=s.id
    WINDOW duplicates AS (PARTITION BY o.source_id,coalesce(members.store_product_id,l.id),o.price,o.regular_price,o.promo_price,o.unit_price,o.available,o.promotion)
  ) SELECT * FROM observations WHERE duplicate_position=1 ORDER BY price NULLS LAST,branch,listing_id`,
      [id],
    )
  ).rows;
}
