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
      expandNameSearch(search, settings.matching.local).map(
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
  const grouped = `SELECT l.product_id AS id,min(b.name) AS name
    FROM catalog_browser b
    JOIN LATERAL (SELECT product_id FROM listings WHERE id=b.listing_id OFFSET 0) l ON true
    GROUP BY l.product_id ${predicates.length ? `HAVING ${predicates.join(" AND ")}` : ""}`;
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
        SELECT min(b.category) AS category,min(b.price) AS price,max(b.highest_price) AS highest_price,
          count(*)::int AS listing_count,count(DISTINCT b.retailer)::int AS connected_retailers,
          array_agg(DISTINCT b.retailer ORDER BY b.retailer) AS retailers,max(b.retrieved_at) AS retrieved_at
        FROM listings l JOIN catalog_browser b ON b.listing_id=l.id WHERE l.product_id=selected.id
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
      `SELECT b.*,l.id,l.product_id,l.match_status,l.attributes,l.gtin,l.description
      FROM catalog_browser b JOIN listings l ON l.id=b.listing_id
      WHERE l.product_id=$1 ORDER BY b.retailer,b.name,l.id`,
      [product.id],
    ),
    offersForProduct(product.id),
    pool.query(
      `SELECT d.*,l.name,l.retailer,
      d.identity_hash=l.identity_hash AS current_identity
      FROM match_decisions d JOIN listings l ON l.id=d.listing_id
      WHERE l.product_id=$1 ORDER BY d.created_at DESC,d.id DESC
      LIMIT $2`,
      [product.id, settings.dashboard.max_page_size],
    ),
  ]);
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
    listings: listings.rows,
    offers,
    decisions: decisions.rows,
  };
}

export async function offersForProduct(id: string) {
  return (
    await pool.query(
      `WITH RECURSIVE chain AS (
         SELECT id,redirect_id FROM products WHERE id=$1
         UNION ALL SELECT p.id,p.redirect_id FROM products p JOIN chain c ON p.id=c.redirect_id
       ), identities AS (
         SELECT DISTINCT retailer,identity_hash,external_key FROM listings
         WHERE product_id=(SELECT id FROM chain WHERE redirect_id IS NULL)
       ), members AS (
         SELECT DISTINCT l.id FROM identities i JOIN listings l
           ON l.retailer=i.retailer AND l.identity_hash=i.identity_hash AND l.external_key=i.external_key
       )
       SELECT l.name,l.retailer,s.name AS branch,s.scope,o.*
       FROM members JOIN listings l ON l.id=members.id
       JOIN offers o ON o.listing_id=l.id JOIN sources s ON s.id=o.source_id
       WHERE s.active ORDER BY o.price NULLS LAST,s.name,l.id`,
      [id],
    )
  ).rows;
}
