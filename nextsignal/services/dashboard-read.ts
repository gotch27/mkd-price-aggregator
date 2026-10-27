import { readSettings } from "./task-settings";
import { settings } from "@/nextsignal/config";
import type {
  DashboardPage,
  DashboardQuery,
  DashboardRow,
  TableView,
} from "@/nextsignal/domain/dashboard";
import { normalizeName } from "@/nextsignal/domain/normalize";
import { expandNameSearch } from "@/nextsignal/domain/local-matching";
import { pool } from "@/nextsignal/services/database";
import { dashboardSummary } from "@/nextsignal/services/catalog-repository";
import { browserStatus } from "@/nextsignal/services/catalog-browser";
import { readUniversalProducts } from "@/nextsignal/services/product-browser";
import { matchingStatus } from "@/nextsignal/services/matching-repository";
import { createReadCache } from "@/nextsignal/services/read-cache";
import { logEvent } from "@/nextsignal/adapters/log-context";
import { readProductStatistics } from "@/nextsignal/services/product-statistics";
import { availabilitySql, availableIdentitySql } from "./product-availability";

type QueryPlan = {
  from: string;
  where: string;
  values: unknown[];
  select: string;
  order: string;
};
const cachedSummary = createReadCache(
  settings.dashboard.summary_cache_ms,
  readSummary,
);

export async function readDashboard(input: DashboardQuery) {
  const started = performance.now();
  const result =
    input.view === "summary"
      ? await cachedSummary()
      : input.view === "products"
        ? await readProducts(input)
        : input.view === "universal"
          ? await readUniversalProducts(input)
          : await readTable(input, input.view);
  await logEvent("debug", "dashboard.read.completed", "Dashboard data loaded", {
    view: input.view,
    retailer: input.retailer,
    source_id: input.source_id,
    page: input.page,
    duration_ms: Math.round(performance.now() - started),
  });
  return result;
}

async function readSummary() {
  const runtime = await readSettings();
  const statistics = await readProductStatistics();
  const [retailers, counts, ai, status, matching] = await Promise.all([
    dashboardSummary(),
    pool.query(
      `SELECT (SELECT coalesce(sum(row_count),0)::bigint FROM sources WHERE active) AS listings,
      (SELECT coalesce(sum(row_count),0)::bigint FROM sources WHERE active) AS offers,
      (SELECT count(*)::int FROM runs WHERE status IN ('pending','queued','running') AND task_id IN(SELECT id FROM task_executions WHERE state IN ('queued','running'))) AS pending`,
    ),
    pool.query(`SELECT endpoint,status,count(*)::int AS requests,
      sum(input_tokens)::bigint AS input_tokens,sum(output_tokens)::bigint AS output_tokens,
      sum(cost_usd) AS cost_usd FROM ai_usage
      WHERE created_at>=date_trunc('month',now()) GROUP BY endpoint,status`),
    browserStatus(),
    matchingStatus({
      counts: statistics.matching_counts,
      work_counts: statistics.work_counts,
    }),
  ]);
  return {
    retailers: retailers.map((retailer): DashboardRow => ({
      ...retailer,
      unique_products:
        statistics.retailer_counts === null
          ? null
          : (statistics.retailer_counts[String(retailer.slug)] ?? 0),
      availability_counts:
        statistics.availability_counts === null
          ? null
          : (statistics.availability_counts[String(retailer.slug)] ?? {
              available: 0,
              unavailable: 0,
              unknown: 0,
            }),
    })),
    counts: { ...statistics.counts, ...counts.rows[0] },
    statistics_updated_at: statistics.updated_at,
    statistics_pending: statistics.pending,
    freshness_hours: settings.ingestion.freshness_hours,
    ai: ai.rows,
    matching,
    ai_enabled: runtime.policy.ai_enabled,
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
        from: "matching_decision_browser d",
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
      expandNameSearch(input.search, settings.matching.local).map(
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
    conditions.push(`(
      (b.store_product_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM store_product_sources ss JOIN sources source ON source.id=ss.source_id AND source.active
        WHERE ss.source_id=$${values.length} AND ss.store_product_id=b.store_product_id
      )) OR (b.store_product_id IS NULL AND EXISTS (
        SELECT 1 FROM listings scoped JOIN offers o ON o.listing_id=scoped.id JOIN sources source ON source.id=o.source_id AND source.active
        WHERE o.source_id=$${values.length} AND scoped.retailer=b.retailer
          AND scoped.identity_hash=b.identity_hash AND scoped.external_key=b.external_key
      ))
    )`);
  }
  const sourceParam = input.source_id ? `$${values.length}` : null;
  const availability =
    input.availability ?? settings.dashboard.product_availability;
  if (availability === "available")
    conditions.push(
      availableIdentitySql("b.store_product_id", sourceParam ?? undefined),
    );
  else if (availability !== "all") {
    values.push(availability);
    conditions.push(
      `${availabilitySql("b.store_product_id", sourceParam ?? undefined)}=$${values.length}`,
    );
  }
  const scopeJoin = sourceParam
    ? `JOIN LATERAL (
    SELECT scoped.id,scoped.product_id,scoped.match_status,scoped.attributes,o.price,o.retrieved_at,s.scope,s.name AS catalog_name
    FROM store_product_aliases a JOIN listings scoped ON scoped.id=a.listing_id
    JOIN offers o ON o.listing_id=a.listing_id AND o.source_id=a.source_id
    JOIN sources s ON s.id=o.source_id AND s.active
    WHERE a.source_id=${sourceParam} AND a.store_product_id=selected.store_product_id
    UNION ALL
    SELECT scoped.id,scoped.product_id,scoped.match_status,scoped.attributes,o.price,o.retrieved_at,s.scope,s.name AS catalog_name
    FROM listings scoped JOIN offers o ON o.listing_id=scoped.id JOIN sources s ON s.id=o.source_id AND s.active
    WHERE selected.store_product_id IS NULL AND o.source_id=${sourceParam} AND scoped.retailer=selected.retailer
      AND scoped.identity_hash=selected.identity_hash AND scoped.external_key=selected.external_key
    ORDER BY id LIMIT 1
  ) catalog_offer ON true`
    : "";
  const productId = "selected.product_id";
  const scopeFields = sourceParam
    ? `,catalog_offer.id,catalog_offer.attributes,
      coalesce((SELECT ss.price FROM store_product_sources ss WHERE ss.source_id=${sourceParam} AND ss.store_product_id=selected.store_product_id),catalog_offer.price) AS price,
      coalesce((SELECT ss.highest_price FROM store_product_sources ss WHERE ss.source_id=${sourceParam} AND ss.store_product_id=selected.store_product_id),catalog_offer.price) AS highest_price,
      catalog_offer.retrieved_at,catalog_offer.scope,catalog_offer.catalog_name`
    : "";
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [count, status] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS total FROM store_product_identity_browser b ${where}`,
      values,
    ),
    browserStatus(),
  ]);
  const total = count.rows[0].total;
  const totalPages = Math.ceil(total / size);
  const page = Math.min(input.page, Math.max(1, totalPages));
  // Limit the compact indexed read model first. Fetch attributes and connection
  // information only for those rows, never for every branch copy in the database.
  // OFFSET 0 keeps hydration parameterized per selected identity. Without that
  // boundary PostgreSQL can hash-join the page to a fully aggregated browser.
  const rows = (
    await pool.query(
      `WITH selected AS MATERIALIZED (
      SELECT b.* FROM store_product_identity_browser b ${where}
      ORDER BY b.name,b.browser_id LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    ), hydrated AS (
      SELECT b.*,picked.browser_id FROM selected picked
      CROSS JOIN LATERAL (
        SELECT b.* FROM store_product_browser b
        WHERE b.store_product_id=picked.store_product_id OFFSET 0
      ) b
      WHERE picked.store_product_id IS NOT NULL
      UNION ALL
      SELECT b.*,picked.browser_id FROM selected picked
      CROSS JOIN LATERAL (
        SELECT b.* FROM store_product_browser b
        WHERE b.listing_id=picked.listing_id AND b.store_product_id IS NULL OFFSET 0
      ) b
      WHERE picked.store_product_id IS NULL
    )
    SELECT selected.*,selected.listing_id AS id,selected.product_id,selected.matching_state AS match_status,l.attributes,
      ${availabilitySql("selected.store_product_id", sourceParam ?? undefined)} AS availability,
      (SELECT count(DISTINCT member.retailer)::int FROM store_product_identity_browser member
       WHERE member.product_id=${productId}) AS connected_retailers${scopeFields}
    FROM hydrated selected JOIN listings l ON l.id=selected.listing_id ${scopeJoin}
    ORDER BY selected.name,selected.browser_id`,
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
