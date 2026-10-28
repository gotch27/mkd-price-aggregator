import type { PoolClient } from "pg";
import type { StoreProduct } from "@/nextsignal/domain/matching";
import type {
  CategoryResult,
  TaskResultsPage,
  TaskResultsQuery,
} from "@/nextsignal/domain/task-results";
import { normalizeName } from "@/nextsignal/domain/normalize";
import { settings } from "@/nextsignal/config";
import { pool } from "./database";
import { classificationRequest } from "./ai-gateway";
import { classificationViews } from "./product-categories";

export async function categorySnapshot(
  c: PoolClient,
  productId: string | null,
  expectedKey: string | null,
  reason: string,
): Promise<CategoryResult> {
  const product = productId
    ? (
        await c.query<StoreProduct>(
          "SELECT * FROM store_products WHERE id=$1 FOR SHARE",
          [productId],
        )
      ).rows[0]
    : null;
  const valid =
    product &&
    expectedKey &&
    product.classification_key === expectedKey &&
    (await classificationRequest(product, c)).key === expectedKey;
  if (product?.manual_family != null)
    return {
      source: product.category_review_source === "agent" ? "agent" : "manual",
      name: product.name,
      retailer: product.retailer,
      source_category: product.category,
      search_name: product.normalized_name,
      assigned_category: product.manual_family,
      suggested_category: null,
      probability: null,
      confidence: null,
      threshold: null,
      classification_id: null,
      model: null,
      prompt_key: null,
      outcome: "assigned",
      reason:
        product.category_review_source === "agent"
          ? "Category selected by an agent"
          : "Category selected by a person",
    };
  const classification = valid
    ? (
        await c.query(
          `SELECT * FROM store_product_classifications WHERE store_product_id=$1 AND input_key=$2 AND acceptance_threshold=$3 ORDER BY created_at DESC,id LIMIT 1`,
          [product.id, expectedKey, product.classification_threshold],
        )
      ).rows[0]
    : null;
  const outcome = classification
    ? classification.family === "unknown"
      ? "uncertain"
      : "assigned"
    : "no_category";
  return {
    source: "ai",
    name: product?.name ?? "Product no longer available",
    retailer: product?.retailer ?? "",
    source_category: product?.category ?? null,
    search_name: product?.normalized_name ?? "",
    assigned_category: classification?.family ?? null,
    suggested_category: classification?.selected_family ?? null,
    probability: classification ? Number(classification.probability) : null,
    confidence:
      classification?.confidence == null
        ? null
        : Number(classification.confidence),
    threshold: classification
      ? Number(classification.acceptance_threshold)
      : null,
    classification_id: classification?.id ?? null,
    model: classification?.model ?? null,
    prompt_key: classification?.prompt_key ?? null,
    outcome,
    reason:
      outcome === "assigned"
        ? "Category assigned"
        : outcome === "uncertain"
          ? "Not enough certainty to assign a category"
          : reason,
  };
}

const projection = `SELECT ti.id,coalesce(sp.group_id,ti.group_id) AS product_id,sp.id AS member_id,sp.manual_family AS manual_category,ti.finished_at,
 coalesce(ti.result->>'source','ai') AS source,
 coalesce(ti.result->>'name',sp.name,'Product no longer available') AS name,
 coalesce(ti.result->>'retailer',sp.retailer,'') AS retailer,
 CASE WHEN ti.result IS NULL THEN sp.category ELSE ti.result->>'source_category' END AS source_category,
 coalesce(ti.result->>'search_name',sp.normalized_name,'') AS search_name,
 ti.result->>'assigned_category' AS assigned_category,ti.result->>'suggested_category' AS suggested_category,
 (ti.result->>'probability')::float8 AS probability,(ti.result->>'confidence')::float8 AS confidence,(ti.result->>'threshold')::float8 AS threshold,
 ti.result->>'classification_id' AS classification_id,ti.result->>'model' AS model,ti.result->>'prompt_key' AS prompt_key,
 coalesce(ti.result->>'outcome',CASE WHEN ti.state='pending' THEN 'waiting' ELSE 'no_category' END) AS outcome,
 coalesce(ti.result->>'reason',ti.reason,'Waiting for this task') AS reason
 FROM task_items ti LEFT JOIN LATERAL (
   WITH RECURSIVE resolved AS(SELECT ti.store_product_id AS id UNION SELECT r.to_id FROM store_product_redirects r JOIN resolved previous ON r.from_id=previous.id)
   SELECT current.* FROM store_products current JOIN resolved ON resolved.id=current.id
     WHERE NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=current.id)
 ) sp ON true WHERE ti.task_id=$1`;

export async function taskResults(
  input: TaskResultsQuery,
): Promise<TaskResultsPage | null> {
  const task = (
    await pool.query(
      `SELECT t.id,t.state,t.reason,t.retry_at,t.options,t.processed,coalesce(u.spending_usd,0)::text AS spending_usd,coalesce(u.requests,0)::int AS requests
    FROM task_executions t LEFT JOIN LATERAL(SELECT sum(cost_usd) spending_usd,count(*) requests FROM ai_usage WHERE task_id=t.id) u ON true WHERE t.id=$1 AND t.kind='categorize'`,
      [input.id],
    )
  ).rows[0];
  if (!task) return null;
  const size = Math.min(input.size, settings.dashboard.max_page_size);
  const values = [
    input.id,
    `%${input.search.replace(/[\\%_]/g, "\\$&")}%`,
    `%${normalizeName(input.search).replace(/[\\%_]/g, "\\$&")}%`,
    input.category,
    input.outcome,
  ];
  const filtered = `SELECT * FROM entries WHERE (name ILIKE $2 OR search_name ILIKE $3) AND ($4='' OR coalesce(manual_category,assigned_category)=$4)
    AND ($5='' OR outcome=$5 OR ($5='needs_review' AND outcome IN('uncertain','no_category') AND manual_category IS NULL)
      OR ($5='reviewed' AND outcome IN('uncertain','no_category') AND manual_category IS NOT NULL))`;
  const result = await pool.query(
    `WITH entries AS MATERIALIZED (${projection}),filtered AS MATERIALIZED (${filtered}),
    totals AS(SELECT count(*)::int AS total FROM filtered), selected AS(SELECT * FROM filtered ORDER BY name,id LIMIT $6 OFFSET (SELECT (LEAST($7::numeric,GREATEST(ceil(total::numeric/$6)::int,1))::int-1)*$6 FROM totals))
    SELECT totals.total,selected.* FROM totals LEFT JOIN selected ON true ORDER BY name,id`,
    [...values, size, input.page],
  );
  const [counts, categories] = await Promise.all([
    pool.query(
      `WITH entries AS (${projection}) SELECT count(*)::int total,count(*) FILTER(WHERE outcome='assigned')::int assigned,
      count(*) FILTER(WHERE outcome IN('uncertain','no_category') AND manual_category IS NULL)::int needs_review,
      count(*) FILTER(WHERE outcome IN('uncertain','no_category') AND manual_category IS NOT NULL)::int reviewed,count(*) FILTER(WHERE outcome='waiting')::int waiting,
      count(*) FILTER(WHERE outcome='skipped')::int skipped,
      count(*) FILTER(WHERE outcome='deferred')::int deferred FROM entries`,
      [input.id],
    ),
    pool.query(
      `WITH entries AS (${projection}) SELECT coalesce(manual_category,assigned_category) id,count(*)::int count FROM entries
        WHERE coalesce(manual_category,assigned_category) IS NOT NULL GROUP BY coalesce(manual_category,assigned_category) ORDER BY id`,
      [input.id],
    ),
  ]);
  const total: number = result.rows[0].total,
    totalPages = Math.ceil(total / size);
  const classifications = await classificationViews(
    result.rows.filter((r) => r.member_id).map((r) => r.member_id),
  );
  return {
    task: {
      id: task.id,
      state: task.state,
      reason: task.reason,
      retry_at: task.retry_at,
      stores: task.options.retailers,
      processed: task.processed,
      product_limit: task.options.product_limit,
      spending_usd: task.spending_usd,
      requests: task.requests,
    },
    summary: counts.rows[0],
    categories: categories.rows,
    rows: result.rows
      .filter((r) => r.id)
      .map(({ total: _total, ...row }) => ({
        ...row,
        classification: classifications.get(row.member_id),
      })),
    total,
    page: Math.min(input.page, Math.max(1, totalPages)),
    size,
    total_pages: totalPages,
  };
}
