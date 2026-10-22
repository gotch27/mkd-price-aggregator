import { settings } from "@/nextsignal/config";
import type {
  DashboardPage,
  DashboardQuery,
  TableView,
} from "@/nextsignal/domain/dashboard";
import { normalizeName } from "@/nextsignal/domain/normalize";
import {
  expandNameSearch,
  localMatchingVersion,
} from "@/nextsignal/domain/local-matching";
import { pool } from "@/nextsignal/services/database";
import { dashboardSummary } from "@/nextsignal/services/catalog-repository";
import { browserStatus } from "@/nextsignal/services/catalog-browser";
import { readUniversalProducts } from "@/nextsignal/services/product-browser";

type QueryPlan = {
  from: string;
  where: string;
  values: unknown[];
  select: string;
  order: string;
};
let summaryCache: {
  expires: number;
  value: ReturnType<typeof readSummary>;
} | null = null;

export async function readDashboard(input: DashboardQuery) {
  if (input.view === "summary") return cachedSummary();
  if (input.view === "products") return readProducts(input);
  if (input.view === "universal") return readUniversalProducts(input);
  return readTable(input, input.view);
}

function cachedSummary() {
  if (summaryCache && summaryCache.expires > Date.now())
    return summaryCache.value;
  const value = readSummary().catch((error) => {
    summaryCache = null;
    throw error;
  });
  summaryCache = {
    expires: Date.now() + settings.dashboard.summary_cache_ms,
    value,
  };
  return value;
}

async function readSummary() {
  const [retailers, counts, ai, status, products] = await Promise.all([
    dashboardSummary(),
    pool.query(
      `SELECT count(*)::int AS catalog_items,
      coalesce(sum(offer_count),0)::bigint AS listings,
      count(*) FILTER(WHERE NOT usable_name)::int AS unnamed,
      (SELECT coalesce(sum(row_count),0)::bigint FROM sources WHERE active) AS offers,
      (SELECT count(*)::int FROM runs WHERE status IN ('pending','queued','running')) AS pending,
      (SELECT count(*)::int FROM match_decisions WHERE product_id IS NOT NULL) AS matched,
      (SELECT count(*)::int FROM local_product_keys WHERE version=$1) AS local_indexed,
      (SELECT count(*)::int FROM local_product_keys WHERE version=$1 AND rule_key IS NOT NULL) AS local_eligible
      FROM catalog_browser`,
      [localMatchingVersion(settings.matching.local)],
    ),
    pool.query(`SELECT endpoint,status,count(*)::int AS requests,
      sum(input_tokens)::bigint AS input_tokens,sum(output_tokens)::bigint AS output_tokens,
      sum(cost_usd) AS cost_usd FROM ai_usage
      WHERE created_at>=date_trunc('month',now()) GROUP BY endpoint,status`),
    browserStatus(),
    pool.query(`SELECT count(*)::int AS universal_products,
      count(*) FILTER(WHERE stores>1)::int AS cross_store_products
      FROM (SELECT l.product_id,count(DISTINCT b.retailer) AS stores
      FROM catalog_browser b JOIN listings l ON l.id=b.listing_id
      GROUP BY l.product_id) groups`),
  ]);
  return {
    retailers,
    counts: { ...counts.rows[0], ...products.rows[0] },
    ai: ai.rows,
    ai_enabled: settings.matching.ai.enabled,
    local_enabled: settings.matching.local.enabled,
    refreshed_at: status.completed_at,
    refresh_pending: status.dirty,
  };
}

function tablePlan(
  input: DashboardQuery,
  view: Exclude<TableView, "products" | "universal">,
): QueryPlan {
  switch (view) {
    case "sources":
      return {
        from: "sources s",
        where:
          "s.active AND ($1::text IS NULL OR s.retailer=$1) AND (s.name ILIKE $2 OR s.retailer ILIKE $2)",
        values: [input.retailer ?? null, `%${input.search}%`],
        select: `s.*,latest.status AS latest_status,latest.error AS latest_error,
        (s.last_success>=now()-$3*interval '1 hour') AS fresh`,
        order: "s.retailer,s.name,s.id",
      };
    case "runs":
      return {
        from: "runs r LEFT JOIN sources s ON s.id=r.source_id",
        where:
          "($1::text IS NULL OR r.retailer=$1) AND ($2::uuid IS NULL OR r.id=$2) AND (r.kind ILIKE $3 OR coalesce(s.name,'') ILIKE $3 OR r.id::text ILIKE $3) AND ($4::text IS NULL OR r.status=$4) AND ($5::text IS NULL OR r.kind=$5)",
        values: [
          input.retailer ?? null,
          input.run_id ?? null,
          `%${input.search}%`,
          input.status ?? null,
          input.kind ?? null,
        ],
        select: "r.*,s.name AS source_name",
        order: "r.created_at DESC,r.id DESC",
      };
    case "logs":
      return {
        from: "logs l",
        where:
          "($1::text IS NULL OR l.run_id=$1) AND ($2::text IS NULL OR l.correlation_id=$2) AND ($3::text IS NULL OR l.level=$3) AND ($4::text IS NULL OR l.retailer=$4) AND l.message ILIKE $5",
        values: [
          input.run_id ?? null,
          input.correlation_id ?? null,
          input.level ?? null,
          input.retailer ?? null,
          `%${input.search}%`,
        ],
        select: "l.*",
        order: "l.created_at DESC,l.id DESC",
      };
    case "decisions":
      return {
        from: "match_decisions d",
        where:
          "d.listing_name ILIKE $1 AND ($2::text IS NULL OR d.retailer=$2)",
        values: [`%${input.search}%`, input.retailer ?? null],
        select: "d.*,d.listing_name AS name",
        order: "d.created_at DESC,d.id DESC",
      };
  }
}

async function readTable(
  input: DashboardQuery,
  view: Exclude<TableView, "products" | "universal">,
): Promise<DashboardPage> {
  const plan = tablePlan(input, view);
  const size = Math.min(input.size, settings.dashboard.max_page_size);
  const count = await pool.query(
    `SELECT count(*)::int AS total FROM ${plan.from} WHERE ${plan.where}`,
    plan.values,
  );
  const total = count.rows[0].total;
  const totalPages = Math.ceil(total / size);
  const page = Math.min(input.page, Math.max(1, totalPages));
  const values = [...plan.values];
  let from = plan.from;
  if (view === "sources") {
    // Detail lookup happens only for the requested page, using runs_source_latest.
    from += ` LEFT JOIN LATERAL (SELECT status,error FROM runs WHERE source_id=s.id AND kind='catalog' ORDER BY created_at DESC LIMIT 1) latest ON true`;
    values.push(settings.ingestion.freshness_hours);
  }
  values.push(size, (page - 1) * size);
  const rows = (
    await pool.query(
      `SELECT ${plan.select} FROM ${from} WHERE ${plan.where}
    ORDER BY ${plan.order} LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
  ).rows;
  return {
    view,
    rows,
    page,
    page_size: size,
    total,
    total_pages: totalPages,
    refreshed_at: null,
    refresh_pending: false,
  };
}

async function readProducts(input: DashboardQuery): Promise<DashboardPage> {
  const size = Math.min(input.size, settings.dashboard.max_page_size);
  const quality = input.name_quality ?? settings.dashboard.product_name_quality;
  const search = normalizeName(input.search);
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (input.retailer) {
    values.push(input.retailer);
    conditions.push(`b.retailer=$${values.length}`);
  }
  if (search) {
    values.push(
      expandNameSearch(search, settings.matching.local).map(
        (term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`,
      ),
    );
    conditions.push(`b.normalized_name ILIKE ANY($${values.length}::text[])`);
  }
  if (quality !== "all")
    conditions.push(
      quality === "named" ? "b.usable_name" : "NOT b.usable_name",
    );
  if (input.source_id) {
    values.push(input.source_id);
    conditions.push(`EXISTS (SELECT 1 FROM listings scoped JOIN offers o ON o.listing_id=scoped.id JOIN sources source ON source.id=o.source_id AND source.active
      WHERE o.source_id=$${values.length} AND scoped.retailer=b.retailer
        AND scoped.identity_hash=b.identity_hash AND scoped.external_key=b.external_key)`);
  }
  const sourceParam = input.source_id ? `$${values.length}` : null;
  const scopeJoin = sourceParam
    ? `JOIN LATERAL (
    SELECT scoped.id,scoped.product_id,scoped.match_status,scoped.attributes,o.price,o.retrieved_at,s.scope,s.name AS catalog_name
    FROM listings scoped JOIN offers o ON o.listing_id=scoped.id JOIN sources s ON s.id=o.source_id AND s.active
    WHERE o.source_id=${sourceParam} AND scoped.retailer=selected.retailer
      AND scoped.identity_hash=selected.identity_hash AND scoped.external_key=selected.external_key
    ORDER BY scoped.id LIMIT 1
  ) catalog_offer ON true`
    : "";
  const productId = sourceParam ? "catalog_offer.product_id" : "l.product_id";
  const scopeFields = sourceParam
    ? ",catalog_offer.id,catalog_offer.product_id,catalog_offer.match_status,catalog_offer.attributes,catalog_offer.price,catalog_offer.price AS highest_price,catalog_offer.retrieved_at,catalog_offer.scope,catalog_offer.catalog_name"
    : "";
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [count, status] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS total FROM catalog_browser b ${where}`,
      values,
    ),
    browserStatus(),
  ]);
  const total = count.rows[0].total;
  const totalPages = Math.ceil(total / size);
  const page = Math.min(input.page, Math.max(1, totalPages));
  // Limit the compact indexed read model first. Fetch attributes and connection
  // information only for those rows, never for every branch copy in the database.
  const rows = (
    await pool.query(
      `WITH selected AS MATERIALIZED (
      SELECT b.* FROM catalog_browser b ${where}
      ORDER BY b.name,b.listing_id LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    )
    SELECT selected.*,selected.listing_id AS id,l.product_id,l.match_status,l.attributes,
      (SELECT count(DISTINCT member.retailer)::int FROM listings member
       WHERE member.product_id=${productId}) AS connected_retailers${scopeFields}
    FROM selected JOIN listings l ON l.id=selected.listing_id ${scopeJoin}
    ORDER BY selected.name,selected.listing_id`,
      [...values, size, (page - 1) * size],
    )
  ).rows;
  return {
    view: "products",
    rows,
    page,
    page_size: size,
    total,
    total_pages: totalPages,
    refreshed_at: status.completed_at.toISOString(),
    refresh_pending: status.dirty,
  };
}
