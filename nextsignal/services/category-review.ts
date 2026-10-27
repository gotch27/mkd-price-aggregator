import { settings } from "@/nextsignal/config";
import { transaction } from "./database";
import { classificationViews } from "./product-categories";
import { availabilitySql } from "./product-availability";
import { expandNameSearch } from "@/nextsignal/domain/local-matching";
import { normalizeName } from "@/nextsignal/domain/normalize";
import type {
  CategoryReviewQuery,
  CategoryReviewPage,
} from "@/nextsignal/domain/category-review";
import { logEvent } from "@/nextsignal/adapters/log-context";

export async function readQueue(
  input: CategoryReviewQuery,
): Promise<CategoryReviewPage> {
  const started = performance.now();
  const terms = normalizeName(input.search)
    ? expandNameSearch(input.search, settings.matching.local).map(
        (t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`,
      )
    : [];
  const size = Math.min(input.size, settings.dashboard.max_page_size);
  const result = await transaction(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // Materialize the classified subset before checking branch availability. A
    // lateral LIMIT keeps PostgreSQL from scanning every branch copy for this list.
    // Counts and the selected page share that same bounded eligibility evaluation.
    const selection = (
      await c.query<CategoryReviewPage["counts"] & { id: string | null }>(
        `
      WITH classified AS MATERIALIZED (
        SELECT sp.id,sp.name,model.selected_family,model.probability,
          CASE WHEN sp.manual_family IS NOT NULL AND sp.category_review_source='agent' THEN 'agent' WHEN sp.manual_family IS NOT NULL THEN 'reviewed' WHEN model.family='unknown' THEN 'needs_review' ELSE 'assigned' END AS status
        FROM store_products sp LEFT JOIN store_product_classifications model
          ON model.store_product_id=sp.id AND model.input_key=sp.classification_key AND model.acceptance_threshold=sp.classification_threshold
        WHERE (model.id IS NOT NULL OR sp.manual_family IS NOT NULL)
          AND NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id)
          AND ($1::text IS NULL OR sp.retailer=$1)
          AND (cardinality($2::text[])=0 OR sp.normalized_name ILIKE ANY($2))
      ), eligible AS MATERIALIZED (
        SELECT sp.* FROM classified sp JOIN LATERAL (
          SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active
          WHERE ss.store_product_id=sp.id AND ($3='all' OR (ss.available IS TRUE AND s.availability_indexed_at IS NOT NULL)) LIMIT 1
        ) listed ON true
      ), counts AS (
        SELECT count(*)::int total,count(*) FILTER(WHERE status='needs_review')::int needs_review,
          count(*) FILTER(WHERE status='assigned')::int assigned,count(*) FILTER(WHERE status='reviewed')::int reviewed,count(*) FILTER(WHERE status='agent')::int agent FROM eligible
      ), selected AS (
        SELECT * FROM eligible WHERE $4='all' OR status=$4
        ORDER BY (selected_family='unknown') ASC NULLS LAST,probability DESC NULLS LAST,name,id
        LIMIT $5 OFFSET (SELECT (LEAST($6::numeric,GREATEST(ceil((CASE $4 WHEN 'all' THEN total WHEN 'needs_review' THEN needs_review WHEN 'assigned' THEN assigned WHEN 'agent' THEN agent ELSE reviewed END)::numeric/$5),1))-1)::int*$5 FROM counts)
      )
      SELECT counts.*,selected.id FROM counts LEFT JOIN selected ON true
      ORDER BY (selected.selected_family='unknown') ASC NULLS LAST,selected.probability DESC NULLS LAST,selected.name,selected.id`,
        [
          input.retailer ?? null,
          terms,
          input.availability,
          input.status,
          size,
          input.page,
        ],
      )
    ).rows;
    const {
      total: all,
      needs_review,
      assigned,
      reviewed,
      agent,
    } = selection[0];
    const counts = { total: all, needs_review, assigned, reviewed, agent };
    const total = counts[input.status === "all" ? "total" : input.status],
      pages = Math.ceil(total / size),
      page = Math.min(input.page, Math.max(1, pages)),
      ids = selection.flatMap((r) => (r.id ? [r.id] : []));
    const rows = (
      await c.query(
        `SELECT sp.id,sp.group_id AS product_id,sp.retailer,sp.name,sp.description,sp.category AS source_category,
      sp.facts,${availabilitySql("sp.id")} AS availability FROM store_products sp WHERE sp.id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],sp.id)`,
        [ids],
      )
    ).rows;
    const views = await classificationViews(ids, c);
    return {
      rows: rows.map((r) => ({
        ...r,
        facts: Object.fromEntries(
          Object.entries(r.facts as Record<string, { value: string }>).map(
            ([k, v]) => [k, v.value],
          ),
        ),
        classification: views.get(r.id)!,
      })),
      counts,
      total,
      page,
      page_size: size,
      total_pages: pages,
    };
  });
  await logEvent(
    "debug",
    "products.category_review.loaded",
    "Manual categorization queue loaded",
    {
      status: input.status,
      retailer: input.retailer,
      page: result.page,
      total: result.total,
      duration_ms: Math.round(performance.now() - started),
    },
  );
  return result;
}
