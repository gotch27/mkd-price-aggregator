import { hash } from "@/nextsignal/domain/normalize";
import {
  identityDifferences,
  identityGaps,
  unambiguousGroups,
} from "@/nextsignal/domain/matching-identity";
import type {
  StoreProduct,
  Candidate,
  Comparison,
} from "@/nextsignal/domain/matching";
import { matchingConfig, taskContext, checkpoint } from "./task-context";
import * as repository from "./matching-repository";
import {
  prepareForMatching,
  phase,
  needsIdentityInterpretation,
} from "./matching-preparation";
import { identityCatalog } from "./identity-catalog";
import { comparePairs, pairInput, type PairProof } from "./identity-decisions";
import { logEvent } from "@/nextsignal/adapters/log-context";
const pairId = (a: string, b: string) => [a, b].sort().join(":");
function freeProof(a: StoreProduct, b: StoreProduct) {
  return (
    !identityGaps(a, b, identityCatalog).length &&
    !!(
      (a.local_key && a.local_key === b.local_key) ||
      (a.facts.gtin && a.facts.gtin.value === b.facts.gtin?.value)
    )
  );
}
export async function matchIdentityProduct(
  initial: StoreProduct,
  work: repository.Work,
  campaign: repository.Campaign,
) {
  const ai =
    matchingConfig().gateway.enabled &&
    initial.classified_family != null &&
    matchingConfig().ai_categories.includes(initial.classified_family);
  const currentMembers = await repository.groupMembers(initial.group_id);
  const primaryIds = new Set(currentMembers.map((p) => p.id));
  const comparisons: Comparison[] = [];
  let limited = false;
  let query = (await prepareForMatching(initial, campaign, false)).product;
  const free = await repository.findCandidates(query, "rules");
  const paid = ai ? await repository.findCandidates(query, "ai") : [];
  const rawCandidates = [
    ...new Map([...free, ...paid].map((c) => [c.product.group_id, c])).values(),
  ].slice(0, matchingConfig().candidate_limit);
  const candidates = rawCandidates.filter(
    (c) =>
      !c.members.some((m) =>
        currentMembers.some((p) => p.retailer === m.retailer),
      ),
  );
  if (
    ai &&
    candidates.some(
      (c) =>
        !identityDifferences(query, c.product, identityCatalog).length &&
        !freeProof(query, c.product),
    )
  )
    query = (
      await prepareForMatching(
        query,
        campaign,
        true,
        false,
        candidates.flatMap((c) => c.members),
      )
    ).product;
  const preparedCandidates: Candidate[] = [];
  const limitedGroups = new Set<string>();
  let interpreted = 0;
  for (const candidate of candidates) {
    const conflicting = identityDifferences(
      query,
      candidate.product,
      identityCatalog,
    );
    let members = await repository.groupMembers(candidate.product.group_id);
    if (
      !conflicting.length &&
      ai &&
      members.every(
        (m) =>
          m.availability === "available" &&
          m.classified_family != null &&
          matchingConfig().ai_categories.includes(m.classified_family),
      )
    ) {
      const cap = taskContext()
        ? Math.min(
            taskContext()!.task.policy.counterparts_per_product,
            taskContext()!.live.policy.counterparts_per_product,
          )
        : matchingConfig().identity.counterparts_per_product;
      const preparedMembers: StoreProduct[] = [];
      for (const m of members) {
        const needed = await needsIdentityInterpretation(m, [query]);
        const allow = !needed || interpreted++ < cap;
        if (needed && !allow) {
          limited = true;
          limitedGroups.add(candidate.product.group_id);
        }
        const prepared = await prepareForMatching(m, campaign, allow, true, [
          query,
        ]);
        limited ||= prepared.limited;
        if (prepared.limited) limitedGroups.add(candidate.product.group_id);
        preparedMembers.push(prepared.product);
      }
      members = preparedMembers;
    }
    const representative =
      members.find((m) => m.id === candidate.product.id) ?? candidate.product;
    const group =
      (await repository.getProduct(representative.id)).group_version ?? 0;
    preparedCandidates.push({
      ...candidate,
      product: representative,
      members,
      group_version: group,
    });
  }
  // Refresh the snapshots after preparation wrote facts; no network transaction is held.
  query = await repository.getProduct(query.id);
  const own = await repository.groupMembers(query.group_id);
  const separated = await repository.manuallySeparatedCandidates(
    query,
    preparedCandidates,
  );
  const proofs = new Map<string, PairProof>();
  const targets = new Map<string, StoreProduct>();
  for (const candidate of preparedCandidates) {
    const conflicts = identityDifferences(
      query,
      candidate.product,
      identityCatalog,
    );
    const gaps = identityGaps(query, candidate.product, identityCatalog);
    const base = {
      candidate,
      method: "rules" as const,
      probability: null,
      confidence: null,
    };
    if (separated.has(candidate.product.group_id))
      comparisons.push({
        ...base,
        outcome: "different",
        reason: "Manually marked as different products",
      });
    else if (conflicts.length)
      comparisons.push({
        ...base,
        outcome: "different",
        reason: conflicts.join("; "),
      });
    else if (gaps.length)
      comparisons.push({
        ...base,
        outcome: "needs_info",
        reason: limitedGroups.has(candidate.product.group_id)
          ? `Counterpart interpretation allowance reached; ${gaps.join("; ")}`
          : gaps.join("; "),
      });
    else if (freeProof(query, candidate.product)) {
      comparisons.push({
        ...base,
        outcome: "matched",
        reason: "Same supported exact signature or validated barcode",
        probability: 1,
      });
      proofs.set(pairId(query.id, candidate.product.id), {
        a: query.id,
        b: candidate.product.id,
        left_input: pairInput(query),
        right_input: pairInput(candidate.product),
        probability: 1,
        method: "rules",
        prompt_key: null,
      });
    } else if (
      ai &&
      candidate.members.every(
        (m) =>
          m.availability === "available" &&
          m.classified_family != null &&
          matchingConfig().ai_categories.includes(m.classified_family),
      )
    )
      targets.set(candidate.product.id, candidate.product);
    else
      comparisons.push({
        ...base,
        outcome: "needs_info",
        reason: "This category is not selected for AI matching",
      });
  }
  await phase("comparing", query.id);
  const answers = await comparePairs(
    campaign,
    query,
    [...targets.values()].sort((a, b) => a.id.localeCompare(b.id)),
  );
  for (const candidate of preparedCandidates) {
    const response = answers.get(candidate.product.id);
    if (!response) continue;
    const { answer, result } = response;
    const accepted =
      answer.choice === "same" &&
      answer.probabilities.same >= matchingConfig().threshold;
    comparisons.push({
      candidate,
      outcome: accepted ? "matched" : "needs_info",
      reason: accepted
        ? "Decision and supported identity facts agree"
        : answer.choice === "same"
          ? `Same-product probability is below the required ${matchingConfig().threshold}`
          : "The decision model could not establish the same exact product",
      method: "decision",
      probability: answer.probabilities.same,
      confidence: answer.confidence,
      prompt_key: result.prompt_key,
    });
    if (accepted)
      proofs.set(pairId(query.id, candidate.product.id), {
        a: query.id,
        b: candidate.product.id,
        left_input: pairInput(query),
        right_input: pairInput(candidate.product),
        probability: answer.probabilities.same,
        method: "decision",
        prompt_key: result.prompt_key,
      });
  }
  const positive = comparisons.filter((c) => c.outcome === "matched");
  const ambiguity = unambiguousGroups(
    query,
    positive.map((c) => c.candidate),
  );
  for (const comparison of positive)
    if (ambiguity.held.has(comparison.candidate.product.group_id)) {
      comparison.outcome = "needs_info";
      comparison.reason =
        "Two candidates from the same store remain possible; clear stores can still join";
    }
  const proposed = comparisons.filter((c) => c.outcome === "matched");
  const memberMap = new Map(
    [...own, ...proposed.flatMap((c) => c.candidate.members)].map((p) => [
      p.id,
      p,
    ]),
  );
  const members = [...memberMap.values()];
  const held = new Set<string>();
  // Every new relationship requires its own proof. Existing groups remain atomic.
  for (const a of members) {
    const separations = await repository.manuallySeparatedCandidates(
      a,
      proposed
        .filter((c) => c.candidate.members.every((m) => m.id !== a.id))
        .map((c) => c.candidate),
    );
    const pending: StoreProduct[] = [];
    for (const b of members) {
      if (
        a.id >= b.id ||
        a.group_id === b.group_id ||
        proofs.has(pairId(a.id, b.id))
      )
        continue;
      if (
        separations.has(b.group_id) ||
        identityDifferences(a, b, identityCatalog).length ||
        identityGaps(a, b, identityCatalog).length
      ) {
        if (!primaryIds.has(a.id)) held.add(a.group_id);
        if (!primaryIds.has(b.id)) held.add(b.group_id);
        continue;
      }
      if (freeProof(a, b)) {
        proofs.set(pairId(a.id, b.id), {
          a: a.id,
          b: b.id,
          left_input: pairInput(a),
          right_input: pairInput(b),
          probability: 1,
          method: "rules",
          prompt_key: null,
        });
        continue;
      }
      if (
        ai &&
        a.availability === "available" &&
        b.availability === "available"
      )
        pending.push(b);
      else {
        if (!primaryIds.has(a.id)) held.add(a.group_id);
        if (!primaryIds.has(b.id)) held.add(b.group_id);
      }
    }
    const cross = await comparePairs(campaign, a, pending);
    for (const b of pending) {
      const response = cross.get(b.id)!;
      if (
        response.answer.choice === "same" &&
        response.answer.probabilities.same >= matchingConfig().threshold
      )
        proofs.set(pairId(a.id, b.id), {
          a: a.id,
          b: b.id,
          left_input: pairInput(a),
          right_input: pairInput(b),
          probability: response.answer.probabilities.same,
          method: "decision",
          prompt_key: response.result.prompt_key,
        });
      else {
        if (!primaryIds.has(a.id)) held.add(a.group_id);
        if (!primaryIds.has(b.id)) held.add(b.group_id);
      }
    }
  }
  for (const comparison of comparisons)
    if (
      comparison.outcome === "matched" &&
      held.has(comparison.candidate.product.group_id)
    ) {
      comparison.outcome = "needs_info";
      comparison.reason =
        "The complete proposed group has an unverified or conflicting relationship";
    }
  await logEvent(
    "debug",
    "matching.candidates.checked",
    "Prepared candidates checked against identity evidence",
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
  await checkpoint();
  await phase("saving", query.id);
  const result = await repository.recordResult(
    query,
    work,
    comparisons,
    hash([
      query.id,
      query.fingerprint,
      identityCatalog,
      comparisons.map((c) => [c.candidate.product.id, c.outcome, c.reason]),
    ]),
    !ai
      ? "Category not selected for AI matching; code-based matching checked"
      : candidates.length
        ? "Not enough product information"
        : "No suitable counterpart found",
    !ai
      ? "category_excluded"
      : candidates.length
        ? "needs_info"
        : "no_candidates",
    [...proofs.values()],
  );
  if (!result.stale)
    await repository.finishWork(
      work,
      hash([query.id, query.fingerprint, identityCatalog.version]),
      "completed",
    );
  await logEvent(
    "debug",
    "matching.product.completed",
    "Prepared product matching finished",
    {
      store_product_id: query.id,
      matched: result.matched,
      stale: result.stale,
      candidates: candidates.length,
      ambiguous_groups: ambiguity.held.size,
      limited,
    },
  );
  return result.matched;
}
