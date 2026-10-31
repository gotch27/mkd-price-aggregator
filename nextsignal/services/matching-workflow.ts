import { prepareIdentity } from "@/nextsignal/domain/matching-identity";
import { identityCatalog } from "./identity-catalog";
import { matchIdentityProduct } from "./identity-workflow";
import { matchingRules } from "./brand-catalog";
import {
  matchingConfig,
  taskContext,
  checkpoint,
} from "@/nextsignal/services/task-context";
import { logEvent, withLogContext } from "@/nextsignal/adapters/log-context";
import { hash } from "@/nextsignal/domain/normalize";
import {
  refreshProductFacts,
  type StoreProduct,
} from "@/nextsignal/domain/matching";
import * as repository from "@/nextsignal/services/matching-repository";
import * as gateway from "@/nextsignal/services/ai-gateway";
import {
  withAvailableProducts,
  assertAvailableContext,
} from "./product-availability";

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
  const refreshed =
    stage === "categorize"
      ? refreshProductFacts(
          query,
          await matchingRules(undefined, query.retailer),
          matchingConfig().category_mappings,
        )
      : prepareIdentity(
          query,
          await matchingRules(undefined, query.retailer),
          matchingConfig().category_mappings,
          identityCatalog,
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
  const classificationPlan = await gateway.classificationRequest(query);
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
  return matchIdentityProduct(query, work, campaign);
}
