import { planCounterparts, phase } from "./matching-preparation";
import { identityCatalog } from "./identity-catalog";
import { matchingSnapshot } from "./matching-results";
import type { CategoryResult } from "@/nextsignal/domain/task-results";
import { reviewCategory } from "./llm-category-review";
import { randomUUID } from "node:crypto";
import { settings } from "@/nextsignal/config";
import {
  GatewayCoolingDown,
  TaskPaused,
  type TaskExecution,
} from "@/nextsignal/domain/task-settings";
import { hash } from "@/nextsignal/domain/normalize";
import { pool, transaction, withLock } from "./database";
import { taskContext, checkpoint, matchingConfig } from "./task-context";
import { logEvent } from "@/nextsignal/adapters/log-context";
import * as matching from "./matching-repository";
import { processStoreProduct } from "./matching-workflow";
import { classificationRequest, GatewayDeferred } from "./ai-gateway";
import { categorySnapshot } from "./task-results";
import { notHeldProductSql } from "./task-product-eligibility";
import {
  availableProductSql,
  assertProductAvailable,
  ProductUnavailable,
} from "./product-availability";
type Item = {
  id: string;
  input_id: string;
  store_product_id: string | null;
  group_id: string;
  input_hash: string | null;
  input_version: number | null;
};
async function selectItems(task: TaskExecution) {
  const remaining =
    task.options.product_limit === null
      ? task.policy.batch_size
      : Math.max(0, task.options.product_limit - task.selected);
  const limit = Math.min(
    remaining,
    task.policy.batch_size,
    taskContext()!.live.policy.batch_size,
  );
  if (!limit) return;
  const stageFlag =
    task.kind === "categorize"
      ? "category_pending"
      : task.options.use_ai
        ? "ai_pending"
        : "rules_pending";
  type Selection = {
    input_id: string;
    store_product_id: string;
    group_id: string;
    fingerprint: string;
    manual_facts: unknown;
    version: number;
  };
  // Imports create these store products when publishing a catalog. Tasks only
  // select that layer; they never convert records from older data formats.
  const rows = (
    await pool.query<Selection>(
      `SELECT sp.id AS input_id,sp.id AS store_product_id,sp.group_id,sp.fingerprint,sp.manual_facts,sp.version
    FROM store_products sp LEFT JOIN matching_work w ON w.store_product_id=sp.id
    WHERE sp.retailer=ANY($1::text[]) AND sp.created_at<=$12
      ${task.origin === "automatic" && task.kind === "categorize" ? "AND sp.category_pending AND sp.manual_family IS NULL" : ""}
      AND ${availableProductSql("sp", "$2")}
      AND NOT EXISTS(SELECT 1 FROM task_items ti WHERE ti.task_id=$3 AND (ti.input_id=sp.id OR ti.store_product_id=sp.id))
      AND ($4::boolean OR ${task.kind === "llm_review" ? "true" : `sp.${stageFlag}`})
      ${task.kind === "llm_review" ? `AND sp.manual_family IS NULL AND EXISTS(SELECT 1 FROM store_product_classifications model WHERE model.store_product_id=sp.id AND model.input_key=sp.classification_key AND model.acceptance_threshold=sp.classification_threshold AND model.family='unknown')` : ""}
      AND ($5=false OR sp.classified_family=ANY($6::text[]))
      AND ($15::uuid IS NULL OR EXISTS(SELECT 1 FROM task_items previous WHERE previous.task_id=$15 AND previous.store_product_id=sp.id AND previous.state IN ('unresolved','deferred')))
      AND ($7::text='manual' OR ${notHeldProductSql("$8", "$3")})
      AND ($7::text='manual' OR ($8='categorize' AND sp.manual_family IS NULL AND ($14 OR w.auto_category_epoch=$9)) OR ($8='match' AND w.auto_match_epoch=$10 AND (NOT $5 OR w.auto_ai_epoch=$11)))
    ORDER BY sp.id LIMIT $13`,
      [
        task.options.retailers,
        task.options.source_id,
        task.id,
        task.options.recheck,
        task.kind === "match" && task.options.use_ai,
        task.options.categories,
        task.origin,
        task.kind,
        task.epochs.categorization,
        task.epochs.matching,
        task.epochs.ai,
        task.created_at,
        limit,
        taskContext()!.live.category_backlog_active,
        task.options.recheck_task_id ?? null,
      ],
    )
  ).rows;
  await transaction(async (c) => {
    for (const row of rows)
      await c.query(
        `INSERT INTO task_items(task_id,input_id,store_product_id,group_id,input_hash,input_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [
          task.id,
          row.input_id,
          row.store_product_id,
          row.group_id,
          hash([row.fingerprint, row.manual_facts]),
          row.version,
        ],
      );
    await c.query(
      `UPDATE task_executions SET selected=(SELECT count(*) FROM task_items WHERE task_id=$1) WHERE id=$1`,
      [task.id],
    );
  });
}
export async function productTask(task: TaskExecution) {
  const started = Date.now();
  // One matcher, including manual tasks, keeps graph updates deterministic.
  const acquired = await withLock("matching", async () => {
    const batchSize = Math.min(
      task.policy.batch_size,
      taskContext()!.live.policy.batch_size,
    );
    let items = (
      await pool.query<Item>(
        `SELECT * FROM task_items WHERE task_id=$1 AND state='pending' ORDER BY created_at,id LIMIT $2`,
        [task.id, batchSize],
      )
    ).rows;
    if (!items.length && !task.checkpoint.retry_deferred_only) {
      await selectItems(task);
      items = (
        await pool.query<Item>(
          `SELECT * FROM task_items WHERE task_id=$1 AND state='pending' ORDER BY created_at,id LIMIT $2`,
          [task.id, batchSize],
        )
      ).rows;
    }
    if (items.length)
      await logEvent(
        "info",
        "tasks.batch.started",
        ["categorize", "llm_review"].includes(task.kind)
          ? `Categorizing ${items.length} products`
          : "Product task batch started",
        {
          task_id: task.id,
          kind: task.kind,
          products: items.length,
        },
      );
    if (task.kind === "match") {
      if (task.checkpoint.identity_version !== hash(identityCatalog))
        throw new TaskPaused(
          "Matching rules changed. Review a new matching task to continue; saved results are retained.",
        );
      await phase("planning");
      await planCounterparts(
        task,
        items.flatMap((i) => (i.store_product_id ? [i.store_product_id] : [])),
      );
    }
    for (const item of items) {
      await checkpoint(task.options.use_ai);
      const id = item.store_product_id;
      if (!id) {
        await finishItem(
          task,
          item,
          false,
          "Product is no longer available",
          task.kind === "categorize",
        );
        continue;
      }
      const product = await matching.getProduct(id);
      const inputHash = hash([product.fingerprint, product.manual_facts]);
      if (item.input_hash && item.input_hash !== inputHash) {
        await finishItem(
          task,
          item,
          false,
          "Product changed after the task selected it",
          task.kind === "categorize",
        );
        continue;
      }
      try {
        await assertProductAvailable(id, task.options.source_id);
      } catch (error) {
        if (!(error instanceof ProductUnavailable)) throw error;
        await finishItem(task, item, false, error.message, false, null, true);
        continue;
      }
      await pool.query(
        `UPDATE task_items SET store_product_id=$2,input_hash=$3 WHERE id=$1`,
        [item.id, id, inputHash],
      );
      const campaign = await taskCampaign(task, id);
      const token = randomUUID();
      const work = (
        await pool.query<matching.Work>(
          `INSERT INTO matching_work(store_product_id,campaign_id,reason,state,token,lease_until) VALUES($1,$2,'Explicit task','running',$3,now()+$4*interval '1 second') ON CONFLICT(store_product_id) DO UPDATE SET campaign_id=$2,state='running',token=$3,lease_until=excluded.lease_until RETURNING *`,
          [id, campaign.id, token, settings.matching.lease_seconds],
        )
      ).rows[0];
      let connected = false;
      let llmResult: CategoryResult | null = null;
      try {
        if (task.kind === "llm_review") {
          llmResult = await reviewCategory(task, campaign, product);
          await matching.releaseClaims([work]);
        } else connected = await processStoreProduct(work, campaign);
      } catch (error) {
        await matching.releaseClaims([work]);
        if (error instanceof ProductUnavailable) {
          await finishItem(task, item, false, error.message, false, null, true);
          continue;
        }
        if (
          error instanceof GatewayDeferred &&
          error.recovery?.action === "retry" &&
          error.recovery.cooldown_until
        )
          throw new GatewayCoolingDown(error.recovery.cooldown_until);
        if (
          error instanceof GatewayDeferred &&
          (error.reason === "inflight" ||
            error.reason === "invalid" ||
            error.recovery?.action === "defer")
        ) {
          await finishItem(
            task,
            item,
            false,
            error.message,
            true,
            null,
            false,
            error,
          );
          await logEvent(
            "warn",
            "tasks.product.deferred",
            "Product set aside; other products can continue",
            {
              task_id: task.id,
              store_product_id: id,
              retailer: product.retailer,
              reason: error.message,
              failure_kind: error.reason,
              ...error.recovery,
            },
          );
          if (error.recovery?.cooldown_until)
            throw new GatewayCoolingDown(error.recovery.cooldown_until);
          continue;
        }
        throw error;
      }
      await pool.query(
        `UPDATE task_executions SET checkpoint=checkpoint-'provider_failures' WHERE id=$1 AND checkpoint ? 'provider_failures'`,
        [task.id],
      );
      await checkpoint();
      if (llmResult) {
        await finishItem(
          task,
          item,
          false,
          llmResult.reason,
          llmResult.outcome !== "assigned",
          null,
          false,
          undefined,
          llmResult,
        );
        continue;
      }
      const flag =
        task.kind === "categorize"
          ? "category_pending"
          : task.options.use_ai
            ? "ai_pending"
            : "rules_pending";
      const current =
        task.kind === "categorize" ? await matching.getProduct(id) : null;
      const categorized =
        current === null ||
        current.manual_family != null ||
        current.classification_key ===
          (await classificationRequest(current)).key;
      if (categorized)
        await pool.query(
          `UPDATE store_products SET ${flag}=false WHERE id=$1 AND fingerprint=$2 AND manual_facts=$3::jsonb AND manual_family IS NOT DISTINCT FROM $4`,
          [
            id,
            product.fingerprint,
            JSON.stringify(product.manual_facts ?? {}),
            current?.manual_family ?? product.manual_family ?? null,
          ],
        );
      await finishItem(
        task,
        item,
        connected,
        task.kind === "categorize"
          ? categorized
            ? "Category saved"
            : "No category saved; product needs attention"
          : connected
            ? "Connected across stores"
            : "Checked; no confirmed new connection",
        !categorized,
        current?.classification_key ?? null,
      );
    }
    if (task.kind === "match") await phase("checkpoint");
    const row = (
      await pool.query(
        `SELECT selected,processed,unresolved,
          (SELECT count(*)::int FROM task_items WHERE task_id=$1 AND state='deferred') AS deferred,
          (SELECT count(*)::int FROM task_items WHERE task_id=$1 AND state='pending') AS pending
         FROM task_executions WHERE id=$1`,
        [task.id],
      )
    ).rows[0];
    const complete =
      items.length === 0 ||
      (task.checkpoint.retry_deferred_only === true && row.pending === 0) ||
      (task.options.product_limit !== null &&
        row.processed >= task.options.product_limit);
    await pool.query(
      `UPDATE task_executions SET state=$2,reason=$3,updated_at=now() WHERE id=$1 AND state='running'`,
      [
        task.id,
        complete ? "completed" : "queued",
        complete
          ? row.deferred > 0
            ? `Selected work finished; ${row.deferred} products set aside for recovery. Saved results are kept.`
            : "Selected work finished; other products remain waiting"
          : "Batch checkpoint saved",
      ],
    );
    await logEvent(
      "info",
      "tasks.batch.completed",
      ["categorize", "llm_review"].includes(task.kind)
        ? complete
          ? "Categorization finished"
          : "Categorization progress saved"
        : "Task checkpoint saved",
      {
        task_id: task.id,
        ...row,
        kind: task.kind,
        ...(["categorize", "llm_review"].includes(task.kind)
          ? {
              category_results_saved: row.processed - row.unresolved,
              without_result: row.unresolved,
            }
          : {}),
        completed: complete,
        duration_ms: Date.now() - started,
        ...(["categorize", "llm_review"].includes(task.kind)
          ? (
              await pool.query(
                `SELECT
        count(*) FILTER(WHERE result->>'outcome'='assigned')::int categories_assigned,
        count(*) FILTER(WHERE result->>'outcome' IN('uncertain','no_category'))::int needs_review
        FROM task_items WHERE task_id=$1`,
                [task.id],
              )
            ).rows[0]
          : {}),
        ...(
          await pool.query(
            `SELECT coalesce(sum(cost_usd),0)::text spent_usd,count(*)::int requests FROM ai_usage WHERE task_id=$1`,
            [task.id],
          )
        ).rows[0],
      },
    );
    return true;
  });
  if (acquired === null)
    await pool.query(
      `UPDATE task_executions SET state='queued',reason='Waiting for the matching worker' WHERE id=$1 AND state='running'`,
      [task.id],
    );
}
async function finishItem(
  task: TaskExecution,
  item: Item,
  connected: boolean,
  reason: string,
  withoutResult = false,
  classificationKey: string | null = null,
  skipped = false,
  deferred?: GatewayDeferred,
  llmResult?: CategoryResult,
) {
  await transaction(async (c) => {
    let snapshot:
      | CategoryResult
      | import("@/nextsignal/domain/matching-results").MatchingResult
      | null =
      llmResult ??
      (task.kind === "categorize" || task.kind === "llm_review"
        ? await categorySnapshot(
            c,
            item.store_product_id,
            classificationKey,
            reason,
          )
        : task.kind === "match"
          ? await matchingSnapshot(c, task, item.store_product_id, reason)
          : null);
    if (skipped) {
      if (snapshot) snapshot = { ...snapshot, outcome: "skipped", reason };
      withoutResult = false;
    }
    if (deferred && snapshot)
      snapshot = {
        ...snapshot,
        ...("source" in snapshot
          ? { source: task.kind === "llm_review" ? "llm" : snapshot.source }
          : {}),
        outcome: "deferred",
        reason,
      };
    if (snapshot) {
      if (task.kind !== "match")
        withoutResult =
          snapshot.outcome === "no_category" ||
          snapshot.outcome === "deferred" ||
          (task.kind === "llm_review" && snapshot.outcome !== "assigned");
      reason = snapshot.reason;
    }
    const changed = await c.query(
      `UPDATE task_items SET state=$2,reason=$3,result=$4,finished_at=now(),deferred_usage_id=$5 WHERE id=$1 AND state='pending' RETURNING id`,
      [
        item.id,
        deferred
          ? "deferred"
          : withoutResult || (!connected && task.kind === "match")
            ? "unresolved"
            : "completed",
        reason,
        snapshot,
        deferred?.recovery?.usage_id ?? null,
      ],
    );
    if (changed.rowCount) {
      await c.query(
        `UPDATE task_executions SET processed=processed+1,connected=connected+$2,unresolved=unresolved+$3,updated_at=now() WHERE id=$1`,
        [
          task.id,
          connected ? 1 : 0,
          withoutResult || (!connected && task.kind === "match") ? 1 : 0,
        ],
      );
      if (deferred && item.store_product_id && task.kind !== "llm_review") {
        const current = (
          await c.query<{
            fingerprint: string;
            manual_facts: unknown;
            version: number;
          }>(
            "SELECT fingerprint,manual_facts,version FROM store_products WHERE id=$1 FOR SHARE",
            [item.store_product_id],
          )
        ).rows[0];
        if (
          current &&
          hash([current.fingerprint, current.manual_facts]) === item.input_hash
        ) {
          await c.query("UPDATE task_items SET input_version=$2 WHERE id=$1", [
            item.id,
            current.version,
          ]);
          // Do not create a fresh automatic task every minute for this same
          // failure. A real product change grants automation again; a person
          // can deliberately retry the deferred item meanwhile.
          const grant =
            task.kind === "categorize"
              ? "auto_category_epoch"
              : task.options.use_ai
                ? "auto_ai_epoch"
                : "auto_match_epoch";
          await c.query(
            `UPDATE matching_work SET ${grant}=NULL WHERE store_product_id=$1`,
            [item.store_product_id],
          );
        }
      }
    }
  });
}
async function taskCampaign(task: TaskExecution, productId: string) {
  return transaction(async (c) => {
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtext('matching-campaigns'))`,
    );
    const cutoff = (
      await c.query(
        `UPDATE operational_settings SET initial_cutoff=coalesce(initial_cutoff,now()) WHERE id RETURNING initial_cutoff`,
      )
    ).rows[0].initial_cutoff;
    const baseline = (
      await c.query(
        `SELECT 1 FROM store_products sp JOIN products p ON p.id=sp.group_id WHERE sp.id=$1 AND p.created_at<=$2`,
        [productId, cutoff],
      )
    ).rowCount;
    let campaign: matching.Campaign;
    if (baseline) {
      await c.query(
        `INSERT INTO matching_campaigns(kind,state,reason) VALUES('initial','running','Explicit initial tasks') ON CONFLICT DO NOTHING`,
      );
      campaign = (
        await c.query<matching.Campaign>(
          `SELECT * FROM matching_campaigns WHERE kind='initial'`,
        )
      ).rows[0];
      await c.query(
        `UPDATE matching_campaigns SET state='running' WHERE id=$1`,
        [campaign.id],
      );
      campaign.state = "running";
    } else {
      const previous = task.campaign_id
        ? (
            await c.query<matching.Campaign>(
              `SELECT * FROM matching_campaigns WHERE id=$1 AND kind='incremental'`,
              [task.campaign_id],
            )
          ).rows[0]
        : null;
      campaign =
        previous ??
        (
          await c.query<matching.Campaign>(
            `INSERT INTO matching_campaigns(kind,state,reason,source_id) VALUES('incremental','running','Explicit scoped task',$1) RETURNING *`,
            [task.options.source_id],
          )
        ).rows[0];
    }
    await c.query(`UPDATE task_executions SET campaign_id=$2 WHERE id=$1`, [
      task.id,
      campaign.id,
    ]);
    task.campaign_id = campaign.id;
    return campaign;
  });
}
