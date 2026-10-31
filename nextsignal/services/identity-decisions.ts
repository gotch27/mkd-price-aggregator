import type { StoreProduct, Candidate } from "@/nextsignal/domain/matching";
import { hash } from "@/nextsignal/domain/normalize";
import { identityRequest } from "@/nextsignal/domain/matching-identity";
import { pool, transaction } from "./database";
import {
  compare,
  comparisonRequest,
  GatewayDeferred,
  GatewayInputTooLarge,
  type ChoiceAnswer,
  type GatewayResult,
} from "./ai-gateway";
import { matchingConfig, taskContext } from "./task-context";
import { matchingPrompts } from "./matching-prompts";
import { identityCatalog } from "./identity-catalog";
import { logEvent } from "@/nextsignal/adapters/log-context";
import type { Campaign as MatchingCampaign } from "./matching-repository";
export type PairProof = {
  a: string;
  b: string;
  left_input: string;
  right_input: string;
  probability: number;
  method: "rules" | "decision";
  prompt_key: string | null;
};
export type PairAnswer = ChoiceAnswer & { clarification?: ChoiceAnswer | null };
export class PairResponses extends Map<
  string,
  { answer: PairAnswer; result: GatewayResult }
> {
  readonly deferred = new Map<string, GatewayDeferred>();
  interruption: GatewayDeferred | null = null;
}
export const pairInput = (p: StoreProduct) =>
  hash(identityRequest(p, identityCatalog));
export function pairKey(a: StoreProduct, b: StoreProduct) {
  const [left, right] = [a, b].sort((a, b) => a.id.localeCompare(b.id));
  const prompt = matchingPrompts.bundle(
    "comparison",
    [left.retailer, right.retailer],
    [left.family, right.family],
  );
  return {
    key: hash([
      matchingConfig().gateway.base_url,
      matchingConfig().gateway.decision_model,
      identityCatalog,
      prompt.key,
      identityRequest(left, identityCatalog),
      identityRequest(right, identityCatalog),
    ]),
    left,
    right,
    prompt,
  };
}
export async function comparePairs(
  campaign: MatchingCampaign,
  query: StoreProduct,
  targets: StoreProduct[],
) {
  const output = new PairResponses();
  const pending: {
    target: StoreProduct;
    key: string;
    left: StoreProduct;
    right: StoreProduct;
    prompt: ReturnType<typeof matchingPrompts.bundle>;
  }[] = [];
  let reused = 0;
  for (const target of targets) {
    const prepared = pairKey(query, target);
    const cached = (
      await pool.query<{ answer: PairAnswer; receipt: GatewayResult }>(
        "SELECT answer,receipt FROM matching_pair_answers WHERE key=$1",
        [prepared.key],
      )
    ).rows[0];
    if (cached) {
      reused++;
      output.set(target.id, {
        answer: cached.answer,
        result: { ...cached.receipt, cached: true },
      });
      await logEvent(
        "debug",
        "matching.pair.reused",
        "Saved product-pair answer reused",
        { a: query.id, b: target.id },
      );
    } else pending.push({ target, ...prepared });
  }
  if (reused && taskContext())
    await pool.query(
      "UPDATE task_executions SET checkpoint=jsonb_set(checkpoint,'{pair_cache_hits}',to_jsonb(coalesce((checkpoint->>'pair_cache_hits')::int,0)+$2::int)) WHERE id=$1",
      [taskContext()!.task.id, reused],
    );
  async function evaluate(batch: typeof pending): Promise<void> {
    if (output.interruption) {
      for (const { target } of batch)
        output.deferred.set(target.id, output.interruption);
      return;
    }
    const candidates = batch.map(
      ({ target }) =>
        ({
          product: target,
          members: [target],
          group_version: target.group_version ?? 0,
          reasons: ["Prepared cross-store product pair"],
          score: 0,
        }) satisfies Candidate,
    );
    // Split the actual encoded payload, including prompts and routing questions.
    // Nothing is truncated and no provider request is made for the oversized batch.
    const plan = comparisonRequest(query, candidates);
    if (
      plan.inputBytes > matchingConfig().gateway.max_input_bytes &&
      batch.length > 1
    ) {
      await logEvent(
        "debug",
        "matching.comparison.split",
        "Comparison batch split to fit the Gateway input limit",
        {
          store_product_id: query.id,
          candidates: batch.length,
          input_bytes: plan.inputBytes,
          limit_bytes: matchingConfig().gateway.max_input_bytes,
        },
      );
      const middle = Math.ceil(batch.length / 2);
      await evaluate(batch.slice(0, middle));
      await evaluate(batch.slice(middle));
      return;
    }
    let answers: Awaited<ReturnType<typeof compare>>;
    try {
      answers = await compare(campaign, query, candidates);
    } catch (error) {
      if (!(error instanceof GatewayDeferred)) throw error;
      for (const { target } of batch) output.deferred.set(target.id, error);
      // One impossible input need not block other pairs. Provider/budget failures
      // stop paid work; the coordinator saves independent code proofs first.
      if (!(error instanceof GatewayInputTooLarge)) output.interruption = error;
      return;
    }
    await transaction(async (c) => {
      for (let n = 0; n < answers.length; n++) {
        const prepared = batch[n],
          { answer: choice, result, clarification } = answers[n];
        const answer: PairAnswer = { ...choice, clarification };
        await c.query(
          `INSERT INTO matching_pair_answers(key,left_id,right_id,left_input,right_input,model,prompt_key,answer,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
          [
            prepared.key,
            prepared.left.id,
            prepared.right.id,
            pairInput(prepared.left),
            pairInput(prepared.right),
            result.model,
            prepared.prompt.key,
            answer,
            result,
          ],
        );
        output.set(prepared.target.id, { answer, result });
      }
    });
  }
  for (
    let i = 0;
    i < pending.length;
    i += matchingConfig().candidate_batch_size
  )
    await evaluate(pending.slice(i, i + matchingConfig().candidate_batch_size));
  return output;
}
