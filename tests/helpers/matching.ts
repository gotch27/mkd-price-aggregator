// Isolated integration harness for domain matching tests. Application workers
// execute reviewed Tasks; no run-based matcher or migration backfill is exposed.
import { matchingConfig } from "@/nextsignal/services/task-context";
import { logEvent, withLogContext } from "@/nextsignal/adapters/log-context";
import { hash } from "@/nextsignal/domain/normalize";
import { pool, transaction } from "@/nextsignal/services/database";
import * as repository from "@/nextsignal/services/matching-repository";
import { processStoreProduct } from "@/nextsignal/services/matching-workflow";
import * as gateway from "@/nextsignal/services/ai-gateway";
import {
  availableProductSql,
  ProductUnavailable,
} from "@/nextsignal/services/product-availability";
import type { Campaign } from "@/nextsignal/services/matching-repository";
import { settings } from "@/nextsignal/config";

if (!new URL(settings.database.url).pathname.endsWith("_test"))
  throw new Error(
    "Matching test orchestration requires an isolated test database",
  );

export async function campaignForRun(runId: string, sourceId: string | null) {
  // Publishing the run's campaign reference and assigning its work must be one
  // transaction: another worker must never observe the former without the latter.
  return transaction(async (c) => {
    await c.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [runId]);
    const existing = (
      await c.query<Campaign>(
        `SELECT mc.* FROM runs r JOIN matching_campaigns mc ON mc.id::text=r.checkpoint->>'campaign_id' WHERE r.id=$1`,
        [runId],
      )
    ).rows[0];
    const campaign =
      existing ?? (await repository.ensureCampaign("incremental", sourceId));
    await c.query(
      `UPDATE runs SET checkpoint=checkpoint||jsonb_build_object('campaign_id',$2::text) WHERE id=$1`,
      [runId, campaign.id],
    );
    await c.query(
      `WITH batch AS (
      SELECT w.id FROM matching_work w JOIN store_products sp ON sp.id=w.store_product_id
      WHERE w.campaign_id IS NULL AND w.state='pending' AND ${availableProductSql("sp")}
        AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM store_product_aliases a WHERE a.store_product_id=sp.id AND a.source_id=$2))
      ORDER BY w.created_at,w.id LIMIT $3 FOR UPDATE OF w SKIP LOCKED
    ) UPDATE matching_work w SET campaign_id=$1 FROM batch WHERE w.id=batch.id`,
      [campaign.id, sourceId, settings.maintenance.batch_size],
    );
    return campaign;
  });
}
export async function requeueSelectedCategories(sourceId: string | null) {
  if (!matchingConfig().ai_categories.length) return 0;
  const result = await pool.query(
    `WITH selected AS (
    SELECT sp.id FROM store_products sp JOIN matching_work w ON w.store_product_id=sp.id
    WHERE sp.state='category_excluded' AND w.state='completed' AND sp.classified_family=ANY($1::text[]) AND ${availableProductSql("sp")}
      AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM store_product_aliases a WHERE a.store_product_id=sp.id AND a.source_id=$3))
    ORDER BY sp.id LIMIT $2 FOR UPDATE OF w SKIP LOCKED
  ) UPDATE matching_work w SET state='pending',campaign_id=NULL,reason='Category selected for AI matching',updated_at=now()
    FROM selected WHERE w.store_product_id=selected.id`,
    [matchingConfig().ai_categories, settings.maintenance.batch_size, sourceId],
  );
  if (result.rowCount)
    await logEvent(
      "info",
      "matching.categories.requeued",
      "Previously excluded products queued after their category was enabled",
      { queued: result.rowCount, categories: matchingConfig().ai_categories },
    );
  return result.rowCount ?? 0;
}

// Products processed before category-first matching may have completed work but
// no saved category, including manually connected products. Queue their first
// categorization without resetting the group or reopening classified products.
export async function requeueUnclassifiedProducts(sourceId: string | null) {
  if (!matchingConfig().gateway.enabled) return 0;
  const result = await pool.query(
    `WITH selected AS (
    SELECT sp.id FROM store_products sp LEFT JOIN matching_work w ON w.store_product_id=sp.id
    WHERE sp.classification_key IS NULL AND sp.classification_attempt_key IS NULL AND sp.manual_family IS NULL AND NOT sp.ambiguous AND NOT sp.branch_conflict
      AND sp.state<>'legacy_conflict' AND (w.id IS NULL OR w.state='completed') AND ${availableProductSql("sp")}
      AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM store_product_aliases a WHERE a.store_product_id=sp.id AND a.source_id=$2))
    ORDER BY sp.id LIMIT $1 FOR UPDATE OF sp SKIP LOCKED
  ) INSERT INTO matching_work(store_product_id,reason)
    SELECT id,'Initial shared category needed' FROM selected
    ON CONFLICT(store_product_id) DO UPDATE SET state='pending',campaign_id=NULL,reason=excluded.reason,updated_at=now()
      WHERE matching_work.state='completed'`,
    [settings.maintenance.batch_size, sourceId],
  );
  if (result.rowCount)
    await logEvent(
      "info",
      "matching.classification.queued",
      "Existing products queued for their first shared category",
      { queued: result.rowCount, source_id: sourceId },
    );
  return result.rowCount ?? 0;
}

export async function controlCampaign(
  action: "pause" | "resume",
  sourceId: string | null,
) {
  const result = await transaction(async (c) => {
    const campaigns = (
      await c.query<Campaign>(
        `UPDATE matching_campaigns SET state=$1,reason=$2 WHERE state=$3 AND ($4::uuid IS NULL OR source_id=$4) RETURNING *`,
        [
          action === "pause" ? "paused" : "running",
          action === "pause" ? "Paused by you" : "Resumed by you",
          action === "pause" ? "running" : "paused",
          sourceId,
        ],
      )
    ).rows;
    if (action === "resume" && campaigns.length)
      await c.query(
        `UPDATE matching_work SET state='pending',error=NULL WHERE campaign_id=ANY($1::uuid[]) AND state='deferred'`,
        [campaigns.map((r) => r.id)],
      );
    return campaigns;
  });
  for (const campaign of result)
    await logEvent(
      "info",
      action === "pause"
        ? "matching.campaign.paused"
        : "matching.campaign.resumed",
      action === "pause" ? "Matching paused by you" : "Matching resumed by you",
      {
        campaign_id: campaign.id,
        campaign_kind: campaign.kind,
        source_id: sourceId,
        reason: campaign.reason,
      },
    );
  return result;
}

export async function workRemaining(campaignId: string) {
  return !!(
    await pool.query(
      `SELECT 1 FROM matching_work WHERE campaign_id=$1 AND state IN ('pending','running') LIMIT 1`,
      [campaignId],
    )
  ).rowCount;
}
export async function campaignRunning(campaignId: string) {
  return !!(
    await pool.query(
      `SELECT 1 FROM matching_campaigns WHERE id=$1 AND state='running'`,
      [campaignId],
    )
  ).rowCount;
}
export async function pauseDisabledCampaign(campaignId: string) {
  const result = await pool.query(
    `UPDATE matching_campaigns SET state='paused',paused_at=now(),reason='Gateway matching is disabled' WHERE id=$1 AND state='running'
  AND NOT EXISTS(SELECT 1 FROM matching_work WHERE campaign_id=$1 AND state IN ('pending','running'))
  AND EXISTS(SELECT 1 FROM matching_work WHERE campaign_id=$1 AND state='deferred')`,
    [campaignId],
  );
  if (result.rowCount)
    await logEvent(
      "warn",
      "matching.campaign.paused",
      "Matching paused because Gateway calls are disabled",
      { campaign_id: campaignId, reason: "gateway_disabled" },
    );
}

export async function matchBatch(runId: string, sourceId: string | null) {
  return withLogContext({ data: { run_id: runId, source_id: sourceId } }, () =>
    matchBatchScoped(runId, sourceId),
  );
}
async function matchBatchScoped(runId: string, sourceId: string | null) {
  const campaign = await campaignForRun(runId, sourceId);
  return withLogContext({ data: { campaign_id: campaign.id } }, () =>
    processBatch(campaign),
  );
}
async function processBatch(campaign: repository.Campaign) {
  const started = Date.now();
  const work =
    campaign.state === "running" ? await repository.claimWork(campaign.id) : [];
  await logEvent(
    work.length ? "info" : "debug",
    "matching.batch.started",
    "Matching batch started",
    { claimed: work.length, campaign_state: campaign.state },
  );
  let matched = 0,
    budgetLimited = false,
    ambiguous = 0,
    processed = 0;
  for (let i = 0; i < work.length; i++) {
    processed++;
    try {
      if ((await repository.getProduct(work[i].store_product_id)).ambiguous)
        ambiguous++;
      if (await processStoreProduct(work[i], campaign)) matched++;
    } catch (error) {
      if (error instanceof ProductUnavailable) {
        await repository.releaseClaims([work[i]]);
        await logEvent(
          "debug",
          "matching.product.unavailable",
          "Product skipped because current availability is not confirmed",
          { store_product_id: work[i].store_product_id, reason: error.message },
        );
        continue;
      }
      if (!(error instanceof gateway.GatewayDeferred)) {
        await logEvent(
          "error",
          "matching.batch.failed",
          "Matching batch failed",
          {
            work_id: work[i].id,
            store_product_id: work[i].store_product_id,
            processed,
            duration_ms: Date.now() - started,
          },
          error,
        );
        await repository.releaseClaims(work.slice(i));
        throw error;
      }
      const product = await repository.getProduct(work[i].store_product_id);
      const key = hash([product.fingerprint, matchingConfig().rules_version]);
      if (error.reason === "invalid") {
        await repository.recordResult(
          product,
          work[i],
          [],
          key,
          error.message,
          "needs_info",
        );
        await repository.finishWork(work[i], key, "completed");
        continue;
      }
      await repository.recordDeferred(product, work[i], key, error.message);
      await repository.finishWork(work[i], key, "deferred", error.message);
      if (
        error.reason === "budget" ||
        error.reason === "provider" ||
        error.reason === "inflight"
      ) {
        budgetLimited = error.reason === "budget";
        await repository.pauseCampaign(campaign.id, error.message);
        await repository.releaseClaims(work.slice(i + 1));
        break;
      }
    }
  }
  await repository.completeCampaign(campaign.id);
  if (!matchingConfig().gateway.enabled)
    await pauseDisabledCampaign(campaign.id);
  const summary = {
    processed,
    matched,
    ambiguous,
    ai_disabled: !matchingConfig().gateway.enabled,
    ai_budget_limited: budgetLimited,
    more:
      !budgetLimited &&
      (await campaignRunning(campaign.id)) &&
      (await workRemaining(campaign.id)),
  };
  await logEvent(
    work.length ? "info" : "debug",
    "matching.batch.completed",
    "Matching batch completed",
    { ...summary, duration_ms: Date.now() - started },
  );
  return summary;
}
