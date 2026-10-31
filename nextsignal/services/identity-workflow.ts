import { hash } from "@/nextsignal/domain/normalize";
import {
  identityDifferences,
  identityGaps,
  unambiguousGroups,
  identityFields,
  type IdentityRoute,
} from "@/nextsignal/domain/matching-identity";
import type {
  StoreProduct,
  Candidate,
  Comparison,
  FactName,
} from "@/nextsignal/domain/matching";
import { matchingConfig, taskContext, checkpoint } from "./task-context";
import * as repository from "./matching-repository";
import {
  prepareForMatching,
  phase,
  needsIdentityInterpretation,
  allocateCounterpart,
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
  const separated = await repository.manuallySeparatedCandidates(
    query,
    candidates,
  );
  const eligible = (c: Candidate) =>
    ai &&
    c.members.every(
      (m) =>
        m.availability === "available" &&
        m.classified_family != null &&
        matchingConfig().ai_categories.includes(m.classified_family),
    );
  const targets = candidates.filter(
    (c) =>
      !separated.has(c.product.group_id) &&
      !identityDifferences(query, c.product, identityCatalog).length &&
      !freeProof(query, c.product) &&
      eligible(c),
  );
  await phase("comparing", query.id);
  const inputs = new Map(
    targets.map((c) => [
      c.product.id,
      [pairInput(query), pairInput(c.product)],
    ]),
  );
  const answers = await comparePairs(
    campaign,
    query,
    targets.map((c) => c.product),
  );
  const useful = targets
    .filter((c) => {
      const a = answers.get(c.product.id)?.answer;
      return (
        a &&
        a.clarification?.choice !== "missing_from_source" &&
        (a.choice === "insufficient" ||
          (a.choice === "same" &&
            a.probabilities.same >= matchingConfig().threshold))
      );
    })
    .sort(
      (a, b) =>
        answers.get(b.product.id)!.answer.probabilities.same -
          answers.get(a.product.id)!.answer.probabilities.same ||
        b.score - a.score ||
        a.product.id.localeCompare(b.product.id),
    );
  const routeFields = (route: string | undefined): FactName[] | undefined => {
    const fields: Partial<Record<IdentityRoute, FactName[]>> = {
      brand: ["brand"],
      type: ["type"],
      amount: ["quantity", "unit"],
      flavour: ["flavour"],
      formulation: ["variant", "range", "processing"],
      pack: ["pack"],
      container: ["form"],
    };
    return fields[route as IdentityRoute];
  };
  const cap = taskContext()
    ? Math.min(
        taskContext()!.task.policy.counterparts_per_product,
        taskContext()!.live.policy.counterparts_per_product,
      )
    : matchingConfig().identity.counterparts_per_product;
  const promising = useful.slice(0, cap);
  const peers = promising.flatMap((c) => c.members);
  const requested = promising.flatMap(
    (c) =>
      routeFields(answers.get(c.product.id)?.answer.clarification?.choice) ??
      identityFields(query, identityCatalog, c.members),
  );
  if (promising.length)
    query = (
      await prepareForMatching(query, campaign, true, false, peers, [
        ...new Set(requested),
      ])
    ).product;
  const limitedGroups = new Set<string>();
  let fresh = 0;
  for (const candidate of useful) {
    if (identityDifferences(query, candidate.product, identityCatalog).length)
      continue;
    const fields = routeFields(
      answers.get(candidate.product.id)?.answer.clarification?.choice,
    );
    for (const member of candidate.members) {
      if (!(await needsIdentityInterpretation(member, [query], fields)))
        continue;
      if (fresh >= cap || !(await allocateCounterpart(query.id, member.id))) {
        limitedGroups.add(candidate.product.group_id);
        limited = true;
        continue;
      }
      fresh++;
      const p = await prepareForMatching(
        member,
        campaign,
        true,
        true,
        [query],
        fields,
      );
      if (p.limited) {
        limitedGroups.add(candidate.product.group_id);
        limited = true;
      }
    }
  }
  query = await repository.getProduct(query.id);
  const own = await repository.groupMembers(query.group_id);
  const preparedCandidates: Candidate[] = [];
  for (const candidate of candidates) {
    const members = await repository.groupMembers(candidate.product.group_id);
    const representative =
      members.find((m) => m.id === candidate.product.id) ?? candidate.product;
    preparedCandidates.push({
      ...candidate,
      product: representative,
      members,
      group_version:
        (await repository.getProduct(representative.id)).group_version ?? 0,
    });
  }
  const changed = preparedCandidates.filter((c) => {
    const old = inputs.get(c.product.id);
    return (
      old &&
      eligible(c) &&
      !identityDifferences(query, c.product, identityCatalog).length &&
      !freeProof(query, c.product) &&
      (old[0] !== pairInput(query) || old[1] !== pairInput(c.product))
    );
  });
  // One reconsideration after validated interpretation. Never recurse into Qwen.
  if (changed.length) {
    await phase("comparing", query.id);
    for (const [id, response] of await comparePairs(
      campaign,
      query,
      changed.map((c) => c.product),
    ))
      answers.set(id, response);
  }
  const proofs = new Map<string, PairProof>();
  for (const candidate of preparedCandidates) {
    const conflicts = identityDifferences(
      query,
      candidate.product,
      identityCatalog,
    );
    const gaps = identityGaps(query, candidate.product, identityCatalog);
    const response = answers.get(candidate.product.id);
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
    } else if (response) {
      const { answer, result } = response;
      const accepted =
        !gaps.length &&
        answer.choice === "same" &&
        answer.probabilities.same >= matchingConfig().threshold;
      comparisons.push({
        candidate,
        outcome: accepted ? "matched" : "needs_info",
        method: "decision",
        probability: answer.probabilities.same,
        confidence: answer.confidence,
        prompt_key: result.prompt_key,
        reason: accepted
          ? "Decision and supported identity facts agree"
          : gaps.length
            ? `${limitedGroups.has(candidate.product.group_id) ? "Counterpart interpretation allowance reached; " : answer.clarification?.choice === "missing_from_source" ? "A required detail is absent from the source; " : ""}${gaps.join("; ")}`
            : answer.choice === "same"
              ? `Same-product probability is below the required ${matchingConfig().threshold}`
              : "The decision model could not establish the same exact product",
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
    } else
      comparisons.push({
        ...base,
        outcome: "needs_info",
        reason: gaps.length
          ? gaps.join("; ")
          : "This category is not selected for AI matching",
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
