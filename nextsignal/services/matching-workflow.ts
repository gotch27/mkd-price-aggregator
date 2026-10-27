import {
  matchingConfig,
  taskContext,
  checkpoint,
} from "@/nextsignal/services/task-context";
import { logEvent, withLogContext } from "@/nextsignal/adapters/log-context";
import { settings } from "@/nextsignal/config";
import { hash } from "@/nextsignal/domain/normalize";
import { hasLengthDimensions } from "@/nextsignal/domain/pack-count";
import {
  differences,
  enoughEvidence,
  refreshProductFacts,
  evidenceGaps,
  valueOf,
  type Comparison,
  type StoreProduct,
  type Candidate,
} from "@/nextsignal/domain/matching";
import * as repository from "@/nextsignal/services/matching-repository";
import * as gateway from "@/nextsignal/services/ai-gateway";
import {
  withAvailableProducts,
  assertAvailableContext,
  ProductUnavailable,
} from "./product-availability";

function clarificationFields(product: StoreProduct): string[] {
  const fields: string[] = [];
  // Ask only about signals that actually occur in the source. An omitted model
  // suffix, flavour or count must not trigger requests to invent those facts.
  if (
    !product.facts.quantity &&
    /\d\s*(?:мл|ml|gr|гр|kg|кгр|кг|л|l)(?!\p{L})/iu.test(product.name) &&
    ![
      "baby_care",
      "household",
      "clothing_accessories",
      "fruit",
      "vegetables",
    ].includes(product.family)
  )
    fields.push("quantity", "unit");
  if (
    !product.facts.pack &&
    !hasLengthDimensions(product.name) &&
    /\d\s*(?:\/\s*1|[xх×]|diapers|pcs)/iu.test(product.name)
  )
    fields.push("pack");
  if (
    !product.facts.model &&
    /[A-Z]\d{3,}/u.test(product.name) &&
    ["household", "clothing_accessories"].includes(product.family)
  )
    fields.push("model");
  if (
    !product.facts.brand &&
    product.family !== "unknown" &&
    !["fruit", "vegetables"].includes(product.family)
  )
    fields.push("brand");
  if (!valueOf(product.facts, "type") && product.family !== "unknown")
    fields.push("type");
  return fields.filter(
    (field) => !Object.hasOwn(product.manual_facts ?? {}, field),
  );
}

export async function processStoreProduct(
  work: repository.Work,
  campaign: repository.Campaign,
) {
  return withLogContext(
    {
      data: {
        campaign_id: campaign.id,
        store_product_id: work.store_product_id,
        work_id: work.id,
      },
    },
    async () => {
      const product = await repository.getProduct(work.store_product_id);
      return withLogContext({ data: { retailer: product.retailer } }, () =>
        withAvailableProducts([product.id], product.id, () =>
          processProduct(product, work, campaign),
        ),
      );
    },
  );
}
async function processProduct(
  query: StoreProduct,
  work: repository.Work,
  campaign: repository.Campaign,
) {
  await checkpoint();
  await assertAvailableContext();
  const stage = taskContext()?.task.kind;
  const refreshed = refreshProductFacts(
    query,
    matchingConfig().local,
    matchingConfig().category_mappings,
  );
  if (
    hash([query.facts, query.family, query.local_key]) !==
    hash([refreshed.facts, refreshed.family, refreshed.local_key])
  ) {
    query = await repository.saveFacts(
      query,
      refreshed.facts,
      refreshed.family,
      query.category_hints,
    );
    await logEvent(
      "debug",
      "matching.product.facts_refreshed",
      "Product facts updated using the current language rules",
      {
        rules_version: matchingConfig().rules_version,
        fields: Object.keys(query.facts),
      },
    );
  }
  await logEvent(
    "debug",
    "matching.product.started",
    "Store product matching started",
    { product_name: query.name, revision: query.version, family: query.family },
  );
  const classificationPlan = gateway.classificationRequest(query);
  if (
    !query.manual_family &&
    stage !== "match" &&
    matchingConfig().gateway.enabled &&
    (query.classification_key !== classificationPlan.key ||
      Number(query.classification_threshold) !==
        matchingConfig().category_threshold)
  ) {
    if (
      !(await repository.markClassificationAttempt(
        query,
        classificationPlan.key,
      ))
    ) {
      await repository.recordResult(
        query,
        work,
        [],
        classificationPlan.key,
        "Product changed before categorizing",
        "needs_info",
      );
      return false;
    }
    const classification = await gateway.classify(campaign, query);
    const answer = classification.result.answers.family;
    const saved = await repository.saveClassification(query, {
      key: classification.key,
      family: classification.family,
      hints: classification.hints,
      model: classification.result.model,
      prompt_key: classification.result.prompt_key!,
      selected: answer.choice,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
      generation_id: classification.result.generation_id,
    });
    if (!saved) {
      await repository.recordResult(
        query,
        work,
        [],
        classification.key,
        "Product changed while categorizing",
        "needs_info",
      );
      return false;
    }
    query = saved;
    await logEvent(
      "debug",
      "matching.product.classified",
      "Product category decision received",
      {
        family: classification.family,
        selected_probability: answer.probabilities[answer.choice],
        confidence: answer.confidence,
        category_hints: classification.hints,
        cached: classification.result.cached,
        prompt_key: classification.result.prompt_key,
      },
    );
  } else if (query.classification_key === classificationPlan.key) {
    await logEvent(
      "debug",
      "matching.classification.reused",
      "Saved category reused without an AI call",
      { family: query.classified_family },
    );
  }
  if (stage === "categorize") {
    await repository.finishWork(
      work,
      query.classification_key ?? query.fingerprint,
      "completed",
    );
    return false;
  }
  if (
    query.ambiguous ||
    query.branch_conflict ||
    query.state === "legacy_conflict"
  ) {
    const key = hash([query.fingerprint, matchingConfig().rules_version]);
    await repository.recordResult(
      query,
      work,
      [],
      key,
      "Source identity is ambiguous; product kept separate",
      "needs_info",
    );
    await repository.finishWork(work, key, "completed");
    await logEvent(
      "debug",
      "matching.product.source_conflict",
      "Store product kept separate because its source information needs attention",
      {
        source_ambiguous: query.ambiguous,
        branch_conflict: query.branch_conflict,
        legacy_conflict: query.state === "legacy_conflict",
      },
    );
    return false;
  }
  const aiSelected =
    (stage !== "match" || matchingConfig().gateway.enabled) &&
    query.classified_family != null &&
    matchingConfig().ai_categories.includes(query.classified_family);
  const free = await repository.findCandidates(query, "rules");
  const paid = aiSelected ? await repository.findCandidates(query, "ai") : [];
  const candidates = [
    ...new Map([...free, ...paid].map((c) => [c.product.group_id, c])).values(),
  ].slice(0, matchingConfig().candidate_limit);
  if (!aiSelected)
    await logEvent(
      "debug",
      "matching.category.excluded",
      "Only code-based matching is allowed for this product category",
      {
        family: query.classified_family ?? null,
        category_known: query.classified_family != null,
        selected_categories: matchingConfig().ai_categories,
        code_candidates: free.length,
      },
    );
  await logEvent(
    "debug",
    "matching.candidates.selected",
    "Likely counterparts selected",
    {
      candidate_count: candidates.length,
      candidates: candidates.map((c) => ({
        store_product_id: c.product.id,
        product_name: c.product.name,
        group_id: c.product.group_id,
        member_count: c.members.length,
        reasons: c.reasons,
      })),
    },
  );
  await repository.wakeNeighbors(query);
  const key = hash({
    query: [query.id, query.fingerprint, query.facts],
    candidates: candidates.map((c) => [
      c.product.id,
      c.product.fingerprint,
      c.members.map((m) => [m.id, m.facts]),
    ]),
    rules: matchingConfig().rules_version,
    prompt: matchingConfig().prompt_version,
  });
  const comparisons: Comparison[] = [];
  const pending: Candidate[] = [];
  const manuallySeparated = await repository.manuallySeparatedCandidates(
    query,
    candidates,
  );
  for (const candidate of candidates) {
    if (manuallySeparated.has(candidate.product.group_id)) {
      comparisons.push({
        candidate,
        outcome: "different",
        reason: "Manually marked as different products",
        method: "rules",
        probability: null,
        confidence: null,
      });
      await logEvent(
        "debug",
        "matching.manual.reused",
        "Saved manual separation reused without AI",
        { candidate_group_id: candidate.product.group_id },
      );
      continue;
    }
    const conflict = differences(query, candidate.product);
    if (conflict.length) {
      comparisons.push({
        candidate,
        outcome: "different",
        reason: conflict.join("; "),
        method: "rules",
        probability: null,
        confidence: null,
      });
      continue;
    }
    if (
      enoughEvidence(query, candidate.product) &&
      ((query.local_key !== null &&
        query.local_key === candidate.product.local_key) ||
        (query.facts.gtin &&
          query.facts.gtin.value === candidate.product.facts.gtin?.value))
    ) {
      comparisons.push({
        candidate,
        outcome: "matched",
        reason: "Same supported exact signature or validated barcode",
        method: "rules",
        probability: 1,
        confidence: null,
      });
    } else if (
      aiSelected &&
      candidate.members.every(
        (m) =>
          m.classified_family != null &&
          matchingConfig().ai_categories.includes(m.classified_family),
      )
    ) {
      pending.push(candidate);
    } else
      comparisons.push({
        candidate,
        outcome: "needs_info",
        reason: "This category is not selected for AI matching",
        method: "rules",
        probability: null,
        confidence: null,
      });
  }
  await logEvent(
    "debug",
    "matching.product.rule_checks",
    "Deterministic candidate checks finished",
    {
      exact_candidates: comparisons
        .filter((c) => c.outcome === "matched")
        .map((c) => c.candidate.product.id),
      different_candidates: comparisons
        .filter((c) => c.outcome === "different")
        .map((c) => ({
          store_product_id: c.candidate.product.id,
          reason: c.reason,
        })),
      ai_candidates: pending.length,
    },
  );
  let clarified = false;
  for (
    let start = 0;
    start < pending.length;
    start += matchingConfig().candidate_batch_size
  ) {
    const batch = pending.slice(
      start,
      start + matchingConfig().candidate_batch_size,
    );
    if (!matchingConfig().gateway.enabled) {
      comparisons.push(
        ...batch.map((candidate) => ({
          candidate,
          outcome: "deferred" as const,
          reason: "Gateway matching is disabled",
          method: "rules" as const,
          probability: null,
          confidence: null,
        })),
      );
      continue;
    }
    let answers = await gateway.compare(campaign, query, batch);
    await logAnswers(answers, "initial");
    const needed = clarificationFields(query);
    if (
      (stage == null ||
        (taskContext()?.task.policy.clarification_enabled &&
          taskContext()?.live.policy.clarification_enabled)) &&
      !clarified &&
      needed.length &&
      answers.some(
        (a) =>
          a.answer.choice === "insufficient" ||
          (a.answer.choice === "same" &&
            !enoughEvidence(query, a.candidate.product)),
      )
    ) {
      clarified = true;
      await logEvent(
        "debug",
        "matching.clarification.started",
        "Interpreting source text for missing product facts",
        { fields: needed },
      );
      try {
        const facts = await gateway.clarify(campaign, query, needed);
        // Clarification may fill missing fields, never overwrite supported rules.
        const merged = { ...facts, ...query.facts };
        if (hash(merged) !== hash(query.facts)) {
          query = await repository.saveFacts(
            query,
            merged,
            query.family,
            query.category_hints,
          );
          answers = await gateway.compare(campaign, query, batch);
          await logAnswers(answers, "after_clarification");
        }
      } catch (error) {
        if (
          error instanceof gateway.GatewayDeferred &&
          error.reason === "invalid"
        ) {
          /* Unsupported clarification is a bounded abstention. */
        } else throw error;
      }
    }
    for (const { candidate, answer, result } of answers) {
      const conflict = differences(query, candidate.product);
      const gaps = evidenceGaps(query, candidate.product);
      const same = answer.probabilities.same;
      const accepted =
        answer.choice === "same" &&
        same >= matchingConfig().threshold &&
        !gaps.length;
      comparisons.push({
        candidate,
        outcome: conflict.length
          ? "different"
          : accepted
            ? "matched"
            : "needs_info",
        reason: conflict.length
          ? conflict.join("; ")
          : accepted
            ? "Decision and supported product facts agree"
            : gaps.length
              ? gaps.join("; ")
              : answer.choice === "same"
                ? `AI same-product probability ${same.toFixed(4)} is below the required ${matchingConfig().threshold}`
                : "AI could not establish the same product; no supported difference was supplied",
        method: "decision",
        probability: same,
        confidence: answer.confidence,
        prompt_key: result.prompt_key,
      });
    }
  }
  await logEvent(
    "debug",
    "matching.candidates.checked",
    "Candidate decisions checked against source facts and the matching threshold",
    {
      threshold: matchingConfig().threshold,
      candidates: comparisons.map((c) => ({
        store_product_id: c.candidate.product.id,
        outcome: c.outcome,
        reason: c.reason,
        probability: c.probability,
      })),
    },
  );
  const reason = !aiSelected
    ? query.classified_family == null
      ? "Product category has not been classified; code-based matching checked"
      : "Category not selected for AI matching; code-based matching checked"
    : !candidates.length
      ? "No suitable counterpart found"
      : comparisons.some((c) => c.outcome === "deferred")
        ? "Gateway matching is disabled"
        : comparisons.every((c) => c.outcome === "different")
          ? "Presented candidates have explicit product differences"
          : "Not enough product information";
  await checkpoint();
  for (const comparison of comparisons)
    if (
      comparison.method === "decision" &&
      comparison.outcome === "matched" &&
      (comparison.probability == null ||
        comparison.probability < matchingConfig().threshold)
    ) {
      comparison.outcome = "needs_info";
      comparison.reason =
        "The same-product threshold increased while the request was running";
    }
  const result = await repository.recordResult(
    query,
    work,
    comparisons,
    key,
    reason,
    !aiSelected
      ? query.classified_family == null
        ? "deferred"
        : "category_excluded"
      : "no_candidates",
  );
  if (!result.stale)
    await repository.finishWork(
      work,
      key,
      !result.matched &&
        (query.classified_family == null ||
          comparisons.some((c) => c.outcome === "deferred")) &&
        stage == null
        ? "deferred"
        : "completed",
    );
  if (result.matched)
    await repository.wakeNeighbors(await repository.getProduct(query.id));
  await logEvent(
    "debug",
    "matching.product.completed",
    "Store product matching finished",
    {
      matched: result.matched,
      stale: result.stale,
      candidate_count: candidates.length,
      different: comparisons.filter((c) => c.outcome === "different").length,
      needs_information: comparisons.filter((c) => c.outcome === "needs_info")
        .length,
      deferred: comparisons.filter((c) => c.outcome === "deferred").length,
    },
  );
  return result.matched;
}

async function logAnswers(
  answers: Awaited<ReturnType<typeof gateway.compare>>,
  round: string,
) {
  await logEvent(
    "debug",
    "matching.candidates.decided",
    "AI candidate decisions received",
    {
      round,
      decisions: answers.map(({ candidate, answer, result }) => ({
        store_product_id: candidate.product.id,
        choice: answer.choice,
        selected_probability: answer.probabilities[answer.choice],
        same_probability: answer.probabilities.same,
        confidence: answer.confidence,
        generation_id: result.generation_id,
        cached: result.cached,
      })),
    },
  );
}

export async function matchStoreProductBatch(
  runId: string,
  sourceId: string | null,
) {
  return withLogContext({ data: { run_id: runId, source_id: sourceId } }, () =>
    matchBatchScoped(runId, sourceId),
  );
}
async function matchBatchScoped(runId: string, sourceId: string | null) {
  await repository.backfillStoreProducts();
  const campaign = await repository.campaignForRun(runId, sourceId);
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
    await repository.pauseDisabledCampaign(campaign.id);
  const summary = {
    processed,
    matched,
    ambiguous,
    ai_disabled: !matchingConfig().gateway.enabled,
    ai_budget_limited: budgetLimited,
    more:
      !budgetLimited &&
      (await repository.campaignRunning(campaign.id)) &&
      (await repository.workRemaining(campaign.id)),
  };
  await logEvent(
    work.length ? "info" : "debug",
    "matching.batch.completed",
    "Matching batch completed",
    { ...summary, duration_ms: Date.now() - started },
  );
  return summary;
}
