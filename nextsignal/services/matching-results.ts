import type { PoolClient } from "pg";
import type {
  MatchingResult,
  MatchingResultsPage,
} from "@/nextsignal/domain/matching-results";
import type { TaskExecution } from "@/nextsignal/domain/task-settings";
import type { TaskResultsQuery } from "@/nextsignal/domain/task-results";
import { readableProductText } from "@/nextsignal/domain/product-text";
import { pool, transaction } from "./database";
import { settings } from "@/nextsignal/config";
export async function matchingSnapshot(
  c: Pick<PoolClient, "query">,
  task: TaskExecution,
  id: string | null,
  fallback: string,
): Promise<MatchingResult> {
  const p = id
    ? (
        await c.query(
          "SELECT id,name,retailer,group_id FROM store_products WHERE id=$1",
          [id],
        )
      ).rows[0]
    : null;
  const decisions = id
    ? (
        await c.query(
          `SELECT d.*,cp.name AS candidate_name,cp.retailer AS candidate_store FROM store_match_decisions d LEFT JOIN store_products cp ON cp.id=d.candidate_id WHERE d.store_product_id=$1 AND (d.task_id=$2 OR (d.task_id IS NULL AND d.campaign_id=$3 AND d.created_at>=$4 AND d.created_at<=$5)) ORDER BY d.created_at DESC,d.id`,
          [id, task.id, task.campaign_id, task.created_at, task.updated_at],
        )
      ).rows
    : [];
  const latest = decisions[0]?.input_key;
  const rows = decisions.filter((d) => d.input_key === latest);
  const stores = p
    ? (
        await c.query<{ retailer: string }>(
          "SELECT DISTINCT retailer FROM store_products WHERE group_id=$1 ORDER BY retailer",
          [p.group_id],
        )
      ).rows.map((r) => r.retailer)
    : [];
  const connected = rows.some((d) => d.outcome === "matched");
  const ambiguous = rows.some((d) =>
    /same store|same-store|same chain|same-chain|competing/i.test(d.reason),
  );
  const outcome = connected
    ? "connected"
    : ambiguous
      ? "ambiguous_store"
      : rows.some((d) => d.outcome === "stale")
        ? "stale"
        : rows.length && rows.every((d) => d.outcome === "different")
          ? "different"
          : rows.some((d) => d.outcome === "deferred")
            ? "deferred"
            : rows.some((d) => d.outcome === "needs_info")
              ? "needs_info"
              : task.state === "running" && stores.length > 1
                ? "already_connected"
                : rows.length
                  ? "no_candidates"
                  : "waiting";
  return {
    kind: "match",
    name: p
      ? readableProductText(p.name, p.retailer)
      : "Product no longer available",
    retailer: p?.retailer ?? "",
    product_id: p?.group_id ?? "",
    member_id: id ?? "",
    outcome,
    reason:
      rows.find((d) => d.outcome === "matched")?.reason ??
      rows.find((d) => d.outcome !== "different")?.reason ??
      rows[0]?.reason ??
      fallback,
    stores: task.state === "running" ? stores : connected ? stores : [],
    candidates: rows
      .filter((d) => d.candidate_id)
      .map((d) => ({
        id: d.candidate_id,
        name: readableProductText(
          d.candidate_name ?? d.evidence?.candidate?.name ?? "Counterpart",
          d.candidate_store ?? "",
        ),
        retailer: d.candidate_store ?? "",
        outcome: d.outcome,
        reason: d.reason,
        probability: d.probability == null ? null : Number(d.probability),
        confidence: d.confidence == null ? null : Number(d.confidence),
        method: d.model ? "decision" : "code",
        facts: d.evidence?.candidate_facts ?? {},
        source_facts: d.evidence?.source_facts ?? {},
        retrieval: d.evidence?.retrieval ?? [],
      })),
  };
}
export async function matchingResults(
  input: TaskResultsQuery,
): Promise<MatchingResultsPage | null> {
  return transaction(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const task = (
      await c.query<TaskExecution>(
        "SELECT * FROM task_executions WHERE id=$1 AND kind='match'",
        [input.id],
      )
    ).rows[0];
    if (!task) return null;
    const size = Math.min(input.size, settings.dashboard.max_page_size);
    const base = `WITH history AS MATERIALIZED(SELECT d.store_product_id,
      bool_or(d.outcome='matched') AS connected,bool_or(d.outcome='stale') AS stale,
      bool_or(d.reason ILIKE '%same store%' OR d.reason ILIKE '%competing%') AS ambiguous,
      bool_and(d.outcome='different') AS different,bool_or(d.outcome='needs_info') AS needs_info,bool_or(d.outcome='deferred') AS deferred
      FROM store_match_decisions d WHERE d.task_id=$1 OR(d.task_id IS NULL AND d.campaign_id=$4 AND d.created_at>=$5 AND d.created_at<=$6) GROUP BY d.store_product_id)
      SELECT ti.*,sp.name,sp.normalized_name,coalesce(ti.result->>'outcome',CASE WHEN h.connected THEN 'connected' WHEN ti.state='pending' THEN 'waiting' WHEN ti.state='deferred' OR h.deferred THEN 'deferred' WHEN h.ambiguous THEN 'ambiguous_store' WHEN h.stale THEN 'stale' WHEN h.different THEN 'different' WHEN h.needs_info THEN 'needs_info' WHEN h.store_product_id IS NOT NULL THEN 'no_candidates' ELSE 'waiting' END) AS outcome
      FROM task_items ti LEFT JOIN store_products sp ON sp.id=ti.store_product_id LEFT JOIN history h ON h.store_product_id=ti.store_product_id WHERE ti.task_id=$1 AND $2::text IS NOT NULL AND $3::text IS NOT NULL`;

    const args = [
      task.id,
      input.outcome,
      `%${input.search.replace(/[\\%_]/g, "\\$&")}%`,
      task.campaign_id,
      task.created_at,
      task.updated_at,
    ];
    const filter = `($2='' OR outcome=$2) AND (coalesce(name,'') ILIKE $3 OR coalesce(normalized_name,'') ILIKE $3 OR coalesce(result->'candidates','[]'::jsonb)::text ILIKE $3)`;
    const counts = (
      await c.query<{ outcome: string; count: number }>(
        `WITH entries AS (${base}) SELECT outcome,count(*)::int count FROM entries GROUP BY outcome`,
        [task.id, "", "", task.campaign_id, task.created_at, task.updated_at],
      )
    ).rows;
    const summary: Record<string, number> = {
      total: counts.reduce((n, r) => n + r.count, 0),
    };
    for (const row of counts) summary[row.outcome] = row.count;
    const total = (
      await c.query(
        `WITH entries AS (${base}) SELECT count(*)::int total FROM entries WHERE ${filter}`,
        args,
      )
    ).rows[0].total as number;
    const pages = Math.ceil(total / size),
      page = Math.min(input.page, Math.max(1, pages));
    const items = (
      await c.query(
        `WITH entries AS (${base}) SELECT * FROM entries WHERE ${filter} ORDER BY created_at,id LIMIT $7 OFFSET $8`,
        [...args, size, (page - 1) * size],
      )
    ).rows;
    const entries = [];
    for (const item of items)
      entries.push({
        ...((item.result?.kind === "match"
          ? item.result
          : await matchingSnapshot(
              c,
              task,
              item.store_product_id,
              item.reason ?? "Waiting for matching",
            )) as MatchingResult),
        id: item.id,
        finished_at: item.finished_at,
      });
    const usage = (
      await c.query(
        "SELECT coalesce(sum(cost_usd),0)::text AS spending_usd,count(*)::int AS requests FROM ai_usage WHERE task_id=$1",
        [task.id],
      )
    ).rows[0];
    const preparation = (
      await c.query(
        "SELECT count(*)::int AS planned,count(*) FILTER(WHERE consumed)::int AS consumed FROM matching_task_preparations WHERE task_id=$1",
        [task.id],
      )
    ).rows[0];
    return {
      kind: "match",
      task: {
        id: task.id,
        state: task.state,
        reason: task.reason,
        stores: task.options.retailers,
        processed: task.processed,
        product_limit: task.options.product_limit,
        ...usage,
        phase: String(task.checkpoint.matching_phase ?? task.state),
        counterparts_planned: preparation.planned,
        counterparts_consumed: preparation.consumed,
      },
      summary,
      rows: entries,
      page,
      size,
      total,
      total_pages: pages,
    };
  });
}
