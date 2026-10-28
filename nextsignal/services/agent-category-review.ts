import { matchingRules } from "./brand-catalog";
import type { PoolClient } from "pg";
import { pool, transaction } from "./database";
import { settings } from "@/nextsignal/config";
import { hash, normalizeName } from "@/nextsignal/domain/normalize";
import { families } from "@/nextsignal/domain/matching";
import { expandNameSearch } from "@/nextsignal/domain/local-matching";
import { readableProductText } from "@/nextsignal/domain/product-text";
import { matchingPrompts } from "./matching-prompts";
import {
  classificationViews,
  saveCategoryInTransaction,
} from "./product-categories";
import { availableProductSql } from "./product-availability";
import { ProductGroupConflict } from "./store-product-groups";
import { logEvent } from "@/nextsignal/adapters/log-context";
import type {
  AgentReviewStart,
  AgentReviewSubmission,
  AgentReviewSession,
  AgentReviewContext,
  AgentReviewBatch,
  AgentReviewResult,
} from "@/nextsignal/domain/agent-category-review";

export class AgentReviewConflict extends Error {}
type SessionRow = Omit<AgentReviewStart, "limit"> & {
  product_limit: number;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  id: string;
  actor: string;
  state: AgentReviewSession["state"];
  request_key: string;
};
type ItemRow = {
  store_product_id: string;
  state: AgentReviewResult["state"];
  review_item: AgentReviewBatch["products"][number];
  after_snapshot: string | null;
  batch_id: string | null;
};

async function sessionRow(
  c: Pick<PoolClient, "query">,
  id: string,
  actor: string,
  lock = false,
) {
  const row = (
    await c.query<SessionRow>(
      `SELECT * FROM agent_category_sessions WHERE id=$1 AND actor=$2${lock ? " FOR UPDATE" : ""}`,
      [id, actor],
    )
  ).rows[0];
  if (!row) throw new AgentReviewConflict("Agent review session not found.");
  return row;
}
async function groupLock(c: PoolClient) {
  // Same lock order as human category edits; session locks always follow it.
  await c.query(
    "SELECT pg_advisory_xact_lock(hashtext('store-product-group-commit'))",
  );
}
export async function readSession(
  id: string,
  actor: string,
  c: Pick<PoolClient, "query"> = pool,
): Promise<AgentReviewSession> {
  if (c === pool)
    return transaction(async (client) => {
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      return readSession(id, actor, client);
    });
  const row = await sessionRow(c, id, actor);
  const results = (
    await c.query<AgentReviewResult>(
      `SELECT store_product_id AS member_id,review_item->>'readable_name' AS name,
    review_item->>'retailer' AS retailer,state,category,reason,undo_status FROM agent_category_items WHERE session_id=$1 ORDER BY position`,
      [id],
    )
  ).rows;
  const last = (
    await c.query(
      `SELECT undone_at,EXISTS(SELECT 1 FROM agent_category_items WHERE batch_id=b.id AND state='saved') AS saved
    FROM agent_category_batches b WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [id],
    )
  ).rows[0];
  return {
    id: row.id,
    state: row.state,
    agent_name: row.agent_name,
    agent_model: row.agent_model,
    retailer: row.retailer ?? null,
    search: row.search,
    product_limit: row.product_limit,
    created_at: row.created_at,
    updated_at: row.updated_at,
    acknowledged_at: row.acknowledged_at,
    total: results.length,
    processed: results.filter((r) => r.state !== "pending").length,
    saved: results.filter(
      (r) => r.state === "saved" && r.undo_status !== "restored",
    ).length,
    skipped: results.filter((r) => r.state === "skipped").length,
    rejected: results.filter((r) => r.state === "rejected").length,
    can_undo: !!last?.saved && !last.undone_at,
    results,
  };
}
export async function readContext(actor: string): Promise<AgentReviewContext> {
  const latest = (
    await pool.query(
      "SELECT id FROM agent_category_sessions WHERE actor=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
      [actor],
    )
  ).rows[0];
  return {
    limits: {
      default_products: settings.agent_review.default_products,
      max_products: settings.agent_review.max_products,
      batch_size: settings.agent_review.batch_size,
      results_page_size: settings.agent_review.results_page_size,
      refresh_ms: settings.agent_review.refresh_ms,
    },
    instructions: matchingPrompts.agentReview,
    categories: families.map((id) => ({
      id,
      label: id.replaceAll("_", " "),
      description: matchingPrompts.reviewCategories[id],
    })),
    session: latest ? await readSession(latest.id, actor) : null,
  };
}
export async function startSession(input: AgentReviewStart, actor: string) {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > settings.agent_review.max_products
  )
    throw new AgentReviewConflict(
      "Choose a product limit within the configured session allowance.",
    );
  const key = hash(input);
  const id = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `agent-category-session:${actor}`,
    ]);
    const repeated = (
      await c.query(
        "SELECT id,request_key FROM agent_category_sessions WHERE actor=$1 AND request_id=$2",
        [actor, input.request_id],
      )
    ).rows[0];
    if (repeated) {
      if (repeated.request_key !== key)
        throw new AgentReviewConflict(
          "This request ID was used with different session settings.",
        );
      return repeated.id as string;
    }
    if (
      (
        await c.query(
          "SELECT id FROM agent_category_sessions WHERE actor=$1 AND state='active'",
          [actor],
        )
      ).rowCount
    )
      throw new AgentReviewConflict(
        "An agent review is already active. Read or stop that session before starting another.",
      );
    const terms = normalizeName(input.search)
      ? expandNameSearch(input.search, await matchingRules()).map(
          (t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`,
        )
      : [];
    const rows = (
      await c.query(
        `SELECT sp.id,sp.group_id AS product_id,sp.retailer,sp.name,sp.description,sp.category AS source_category,sp.facts
      FROM store_products sp JOIN store_product_classifications m ON m.store_product_id=sp.id
      AND m.input_key=sp.classification_key AND m.acceptance_threshold=sp.classification_threshold
      WHERE m.family='unknown' AND sp.manual_family IS NULL AND ${availableProductSql("sp")}
      AND NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id)
      AND ($1::text IS NULL OR sp.retailer=$1) AND (cardinality($2::text[])=0 OR sp.normalized_name ILIKE ANY($2))
      ORDER BY (m.selected_family='unknown'),m.probability DESC,sp.name,sp.id LIMIT $3`,
        [input.retailer ?? null, terms, input.limit],
      )
    ).rows;
    const views = await classificationViews(
      rows.map((r) => r.id),
      c,
    );
    const selected = rows.filter((r) => views.get(r.id)?.state === "uncertain");
    const session = (
      await c.query(
        `INSERT INTO agent_category_sessions(actor,request_id,request_key,agent_name,agent_model,retailer,search,product_limit,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          actor,
          input.request_id,
          key,
          input.agent_name,
          input.agent_model,
          input.retailer ?? null,
          input.search,
          input.limit,
          selected.length ? "active" : "completed",
        ],
      )
    ).rows[0].id as string;
    for (const [position, row] of selected.entries()) {
      const item: AgentReviewBatch["products"][number] = {
        ...row,
        availability: "available",
        classification: views.get(row.id)!,
        facts: Object.fromEntries(
          Object.entries(row.facts as Record<string, { value: string }>).map(
            ([k, v]) => [k, v.value],
          ),
        ),
        supported_facts: row.facts,
        readable_name: readableProductText(row.name, row.retailer),
        readable_description:
          row.description === null
            ? null
            : readableProductText(row.description, row.retailer),
        readable_source_category:
          row.source_category === null
            ? null
            : readableProductText(row.source_category, row.retailer),
      };
      await c.query(
        "INSERT INTO agent_category_items(session_id,store_product_id,position,review_item,state,reason) VALUES($1,$2,$3,$4,'pending','')",
        [session, row.id, position, item],
      );
    }
    return session;
  });
  const session = await readSession(id, actor);
  await logEvent(
    "info",
    "products.agent_review.started",
    "Agent category review session ready",
    {
      session_id: id,
      actor,
      total: session.total,
      limit: input.limit,
      retailer: input.retailer,
    },
  );
  return session;
}
export async function readBatch(
  id: string,
  actor: string,
): Promise<AgentReviewBatch> {
  return transaction(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const session = await sessionRow(c, id, actor);
    const rows =
      session.state === "active"
        ? (
            await c.query<ItemRow>(
              "SELECT review_item FROM agent_category_items WHERE session_id=$1 AND state='pending' ORDER BY position LIMIT $2",
              [id, settings.agent_review.batch_size],
            )
          ).rows
        : [];
    return {
      session_id: id,
      state: session.state,
      store_guidance: Object.fromEntries(
        [...new Set(rows.map((r) => r.review_item.retailer))].map(
          (retailer) => [retailer, matchingPrompts.storeGuidance(retailer)],
        ),
      ),
      products: rows.map((r) => r.review_item),
    };
  });
}
export async function submitBatch(input: AgentReviewSubmission, actor: string) {
  if (
    !input.decisions.length ||
    input.decisions.length > settings.agent_review.batch_size ||
    new Set(input.decisions.map((d) => d.member_id)).size !==
      input.decisions.length
  )
    throw new AgentReviewConflict(
      "Submit one bounded batch without duplicate products.",
    );
  for (const d of input.decisions)
    if (
      !d.reason.trim() ||
      d.reason.length > settings.product_details.note_max_length ||
      (d.action === "set"
        ? !families.includes(d.category as (typeof families)[number]) ||
          d.category === "unknown"
        : d.action !== "skip" || d.category !== null)
    )
      throw new AgentReviewConflict(
        "Choose a supported category or skip, with a short reason.",
      );
  const key = hash(input.decisions);
  const result = await transaction(async (c) => {
    await groupLock(c);
    const session = await sessionRow(c, input.id, actor, true);
    const repeated = (
      await c.query(
        "SELECT request_key,result FROM agent_category_batches WHERE session_id=$1 AND request_id=$2",
        [input.id, input.request_id],
      )
    ).rows[0];
    if (repeated) {
      if (repeated.request_key !== key)
        throw new AgentReviewConflict(
          "This request ID was used with different decisions.",
        );
      return {
        ...(repeated.result as {
          batch_id: string;
          results: AgentReviewResult[];
        }),
        replayed: true,
        completed: session.state === "completed",
      };
    }
    if (session.state !== "active")
      throw new AgentReviewConflict(
        "This agent review is stopped or completed. No changes were saved.",
      );
    const batch = (
      await c.query(
        "INSERT INTO agent_category_batches(session_id,request_id,request_key,result) VALUES($1,$2,$3,'{}') RETURNING id",
        [input.id, input.request_id, key],
      )
    ).rows[0].id as string;
    const results: AgentReviewResult[] = [];
    for (const decision of input.decisions) {
      const item = (
        await c.query<ItemRow>(
          "SELECT * FROM agent_category_items WHERE session_id=$1 AND store_product_id=$2",
          [input.id, decision.member_id],
        )
      ).rows[0];
      if (!item)
        throw new AgentReviewConflict(
          "A submitted product is outside this session.",
        );
      if (item.state !== "pending")
        throw new AgentReviewConflict(
          "A submitted product was already processed. Retry its original request ID to read the result.",
        );
      const row: AgentReviewResult = {
        member_id: decision.member_id,
        name: item.review_item.readable_name,
        retailer: item.review_item.retailer,
        state: "rejected",
        category: null,
        reason: decision.reason,
        undo_status: null,
      };
      let snapshot: string | null = null;
      await c.query("SAVEPOINT category_item");
      try {
        if (decision.snapshot !== item.review_item.classification.snapshot)
          throw new ProductGroupConflict(
            "The submitted snapshot does not belong to this session.",
          );
        const current = (
          await classificationViews([decision.member_id], c)
        ).get(decision.member_id);
        if (
          current?.snapshot !== decision.snapshot ||
          current.state !== "uncertain"
        )
          throw new ProductGroupConflict(
            "The product or category changed. Human choices are protected.",
          );
        if (
          !(
            await c.query(
              `SELECT 1 FROM store_products sp WHERE id=$1 AND ${availableProductSql("sp")}`,
              [decision.member_id],
            )
          ).rowCount
        )
          throw new ProductGroupConflict("The product is no longer available.");
        if (decision.action === "skip") row.state = "skipped";
        else {
          const saved = await saveCategoryInTransaction(
            c,
            {
              id: item.review_item.product_id,
              member_id: decision.member_id,
              snapshot: decision.snapshot,
              action: "set",
              category: decision.category,
              note: decision.reason,
            },
            actor,
            { source: "agent", session_id: input.id },
          );
          row.state = "saved";
          row.category = saved.category;
          snapshot = saved.classification.snapshot;
        }
      } catch (error) {
        if (!(error instanceof ProductGroupConflict)) throw error;
        await c.query("ROLLBACK TO SAVEPOINT category_item");
        row.reason = error.message;
      }
      await c.query("RELEASE SAVEPOINT category_item");
      await c.query(
        "UPDATE agent_category_items SET state=$3,category=$4,reason=$5,after_snapshot=$6,batch_id=$7,updated_at=now() WHERE session_id=$1 AND store_product_id=$2",
        [
          input.id,
          decision.member_id,
          row.state,
          row.category,
          row.reason,
          snapshot,
          batch,
        ],
      );
      results.push(row);
    }
    const result = { batch_id: batch, results };
    await c.query("UPDATE agent_category_batches SET result=$2 WHERE id=$1", [
      batch,
      result,
    ]);
    const updated = await c.query<{ state: string }>(
      `UPDATE agent_category_sessions SET updated_at=now(),state=CASE WHEN EXISTS(SELECT 1 FROM agent_category_items WHERE session_id=$1 AND state='pending') THEN 'active' ELSE 'completed' END WHERE id=$1 RETURNING state`,
      [input.id],
    );
    return {
      ...result,
      replayed: false,
      completed: updated.rows[0].state === "completed",
    };
  });
  if (!result.replayed)
    await logEvent(
      result.results.some((r) => r.state === "rejected") ? "warn" : "info",
      "products.agent_review.batch_saved",
      "Agent category review batch finished",
      {
        session_id: input.id,
        batch_id: result.batch_id,
        actor,
        saved: result.results.filter((r) => r.state === "saved").length,
        skipped: result.results.filter((r) => r.state === "skipped").length,
        rejected: result.results.filter((r) => r.state === "rejected").length,
      },
    );
  const session = await readSession(input.id, actor);
  if (!result.replayed && result.completed)
    await logEvent(
      "info",
      "products.agent_review.completed",
      "Agent category review session completed",
      {
        session_id: input.id,
        actor,
        processed: session.processed,
        saved: session.saved,
        skipped: session.skipped,
        rejected: session.rejected,
      },
    );
  return {
    batch_id: result.batch_id,
    results: result.results,
    replayed: result.replayed,
    session,
  };
}
export async function stopSession(id: string, actor: string) {
  await transaction(async (c) => {
    await sessionRow(c, id, actor, true);
    await c.query(
      "UPDATE agent_category_sessions SET state='stopped',updated_at=now() WHERE id=$1 AND state='active'",
      [id],
    );
  });
  await logEvent(
    "info",
    "products.agent_review.stopped",
    "Agent category review stopped",
    { session_id: id, actor },
  );
  return readSession(id, actor);
}
export async function acknowledgeSession(id: string, actor: string) {
  const changed = await transaction(async (c) => {
    const session = await sessionRow(c, id, actor, true);
    if (session.state === "active")
      throw new AgentReviewConflict(
        "Finish or stop the agent review before clicking OK.",
      );
    return !!(
      await c.query(
        "UPDATE agent_category_sessions SET acknowledged_at=now() WHERE id=$1 AND acknowledged_at IS NULL RETURNING id",
        [id],
      )
    ).rowCount;
  });
  if (changed)
    await logEvent(
      "info",
      "products.agent_review.acknowledged",
      "Agent review results dismissed from view; saved choices and history retained",
      { session_id: id, actor },
    );
  return readSession(id, actor);
}
export async function undoBatch(id: string, actor: string) {
  await transaction(async (c) => {
    await groupLock(c);
    await sessionRow(c, id, actor, true);
    const batch = (
      await c.query(
        "SELECT * FROM agent_category_batches WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!batch || batch.undone_at) return;
    const items = (
      await c.query<ItemRow>(
        "SELECT * FROM agent_category_items WHERE batch_id=$1 AND state='saved' ORDER BY position",
        [batch.id],
      )
    ).rows;
    for (const item of items) {
      let status = "changed";
      await c.query("SAVEPOINT undo_category_item");
      try {
        const current = (
          await classificationViews([item.store_product_id], c)
        ).get(item.store_product_id);
        if (
          current?.source !== "agent" ||
          current.snapshot !== item.after_snapshot
        )
          throw new ProductGroupConflict(
            "The category changed after this agent review.",
          );
        await saveCategoryInTransaction(
          c,
          {
            id: item.review_item.product_id,
            member_id: item.store_product_id,
            snapshot: current.snapshot,
            action: "reset",
            category: null,
            note: "Undo agent review batch",
          },
          actor,
          { source: "human", session_id: id },
        );
        status = "restored";
      } catch (error) {
        if (!(error instanceof ProductGroupConflict)) throw error;
        await c.query("ROLLBACK TO SAVEPOINT undo_category_item");
      }
      await c.query("RELEASE SAVEPOINT undo_category_item");
      await c.query(
        "UPDATE agent_category_items SET undo_status=$3,updated_at=now() WHERE session_id=$1 AND store_product_id=$2",
        [id, item.store_product_id, status],
      );
    }
    await c.query(
      "UPDATE agent_category_batches SET undone_at=now() WHERE id=$1",
      [batch.id],
    );
  });
  await logEvent(
    "info",
    "products.agent_review.undone",
    "Agent category review batch undo finished",
    { session_id: id, actor },
  );
  return readSession(id, actor);
}
