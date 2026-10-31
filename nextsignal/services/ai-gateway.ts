import { identityCatalog } from "./identity-catalog";
import {
  identityRequest,
  identityGaps,
} from "@/nextsignal/domain/matching-identity";
import type { PoolClient } from "pg";
import { matchingRules } from "./brand-catalog";
import {
  matchingConfig,
  taskContext,
  checkpoint,
} from "@/nextsignal/services/task-context";
import {
  matchingPrompts,
  type PromptBundle,
} from "@/nextsignal/services/matching-prompts";
import Decimal from "decimal.js";
import { setTimeout as delay } from "node:timers/promises";
import { validateClarification } from "@/nextsignal/domain/clarification";
import { logEvent, withLogContext } from "@/nextsignal/adapters/log-context";
import { z } from "zod";
import { settings } from "@/nextsignal/config";
import { hash, normalizeName } from "@/nextsignal/domain/normalize";
import { classificationSource } from "@/nextsignal/domain/classification-source";
import {
  factNames,
  families,
  requestProduct,
  familyFromText,
  refreshProductFacts,
  type StoreProduct,
  type Facts,
  type Fact,
  type Family,
  type Candidate,
} from "@/nextsignal/domain/matching";
import { pool, transaction } from "@/nextsignal/services/database";
import {
  acquireGatewayPermit,
  releaseGatewayPermit,
  gatewaySucceeded,
  gatewayFailed,
  type GatewayPermit,
} from "./gateway-cooldown";
import type { Campaign } from "@/nextsignal/services/matching-repository";
import {
  assertAvailableContext,
  withAvailableProducts,
} from "./product-availability";

export type GatewayRecovery = {
  action: "retry" | "defer" | "pause";
  usage_id?: string;
  request_key?: string;
  http_status?: number | null;
  billing?: "uncertain" | "rejected";
  cooldown_until?: string;
};
export class GatewayDeferred extends Error {
  constructor(
    message: string,
    public readonly reason:
      "disabled" | "budget" | "provider" | "inflight" | "invalid",
    public readonly recovery?: GatewayRecovery,
  ) {
    super(message);
  }
}
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number | null;
};
export type GatewayResult = {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
  generation_id: string | null;
  cached: boolean;
  prompt_key: string | null;
};
type Questions = Record<
  string,
  { type: "choice"; instructions: string; criteria: Record<string, string> }
>;
const tokenCount = z.number().int().nonnegative();
const probability = z.number().min(0).max(1);
const choiceSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), probability),
  confidence: probability.optional(),
});

function budget(campaign: Campaign) {
  const g = matchingConfig().gateway;
  return campaign.kind === "initial"
    ? g.initial_budget_usd
    : campaign.kind === "evaluation"
      ? g.evaluation_budget_usd
      : g.monthly_budget_usd;
}
type RequestArgs = [
  Campaign,
  "decision" | "extraction",
  Record<string, unknown>,
  { model: string; input_per_million: number; output_per_million: number }?,
  PromptBundle?,
];
async function request(...args: RequestArgs) {
  const limits = matchingConfig().gateway;
  for (let attempt = 1; ; attempt++) {
    const context: { permit: GatewayPermit | null } = { permit: null };
    try {
      const result = await requestOnce(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        context,
      );
      if (!result.__cached) await gatewaySucceeded(context.permit);
      return result;
    } catch (error) {
      if (error instanceof GatewayDeferred && error.reason === "provider") {
        const limited = error.recovery?.http_status === 429;
        if (
          error.recovery?.action === "defer" ||
          (limited &&
            (attempt >= limits.retry_attempts || context.permit?.token))
        ) {
          const until = await gatewayFailed(context.permit, limited);
          if (until && error.recovery) error.recovery.cooldown_until = until;
        } else await releaseGatewayPermit(context.permit);
      } else await releaseGatewayPermit(context.permit);
      // Retry only a confirmed, unbilled rejection. A timeout, 5xx response or
      // missing receipt must never silently repeat a possibly billed request.
      if (
        !(error instanceof GatewayDeferred) ||
        error.recovery?.action !== "retry" ||
        error.recovery.cooldown_until ||
        attempt >= limits.retry_attempts
      )
        throw error;
      const wait = Math.min(
        limits.retry_delay_ms * 2 ** (attempt - 1),
        limits.retry_max_delay_ms,
      );
      await logEvent(
        "warn",
        "gateway.request.retry",
        "AI request rejected without a charge; retrying after a short wait",
        {
          ...error.recovery,
          attempt,
          max_attempts: limits.retry_attempts,
          retry_delay_ms: wait,
        },
      );
      await delay(wait);
      // requestOnce rechecks current permissions, availability and every cap.
    }
  }
}
async function requestOnce(
  campaign: Campaign,
  kind: "decision" | "extraction",
  body: Record<string, unknown>,
  experiment:
    | {
        model: string;
        input_per_million: number;
        output_per_million: number;
      }
    | undefined,
  prompt: PromptBundle | undefined,
  requestContext: { permit: GatewayPermit | null },
): Promise<Record<string, unknown>> {
  await checkpoint(true);
  await assertAvailableContext();
  const g = matchingConfig().gateway;
  if (
    experiment &&
    (campaign.kind !== "evaluation" ||
      !new URL(settings.database.url).pathname.endsWith("_matching_test"))
  )
    throw new Error(
      "Model experiments require an isolated evaluation database",
    );
  const model =
    experiment?.model ??
    (kind === "decision" ? g.decision_model : g.extraction_model);
  const endpoint =
    kind === "decision" ? g.decision_endpoint : g.extraction_endpoint;
  const payload = { ...body, model };
  const key = hash([g.base_url, endpoint, model, payload]);
  if (prompt)
    await pool.query(
      "INSERT INTO matching_prompt_versions(key,files) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [prompt.key, JSON.stringify(prompt.files)],
    );
  const cached = (
    await pool.query("SELECT result FROM ai_cache WHERE key=$1", [key])
  ).rows[0];
  const trace = {
    request_id: key,
    model,
    endpoint,
    prompt_version: matchingConfig().prompt_version,
    prompt_key: prompt?.key ?? null,
    operation: prompt?.operation ?? kind,
    rules_version: matchingConfig().rules_version,
  };
  if (cached) {
    await logEvent(
      "debug",
      "gateway.request.cache_hit",
      "Saved AI response reused; no provider call",
      trace,
    );
    return { ...cached.result, __cached: true };
  }
  if (!g.enabled) {
    await logEvent(
      "debug",
      "gateway.request.disabled",
      "AI request skipped because Gateway calls are disabled",
      trace,
    );
    throw new GatewayDeferred("Gateway matching is disabled", "disabled");
  }
  await pool.query(
    `UPDATE matching_work SET lease_until=now()+$2*interval '1 second' WHERE campaign_id=$1 AND state='running'`,
    [campaign.id, matchingConfig().lease_seconds],
  );
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (bytes > g.max_input_bytes) {
    await logEvent(
      "warn",
      "gateway.request.too_large",
      "AI request skipped because the input exceeds its size limit",
      { ...trace, input_bytes: bytes, limit_bytes: g.max_input_bytes },
    );
    throw new GatewayDeferred(
      "Matching input exceeds its configured size limit",
      "invalid",
    );
  }
  const inputRate =
    experiment?.input_per_million ??
    (kind === "decision"
      ? g.decision_input_per_million
      : g.extraction_input_per_million);
  const outputRate =
    experiment?.output_per_million ??
    (kind === "decision"
      ? g.decision_output_per_million
      : g.extraction_output_per_million);
  const questions =
    kind === "decision" ? Object.keys(body.questions as Questions).length : 1;
  // UTF-8 bytes conservatively bound text tokens, with explicit provider
  // overhead and repeated shared state allowance for native question billing.
  const estimate = new Decimal(bytes + g.token_overhead_allowance)
    .mul(questions)
    .mul(inputRate)
    .plus(
      new Decimal(Number(body.max_tokens ?? g.max_output_tokens)).mul(
        outputRate,
      ),
    )
    .div(1e6);
  requestContext.permit = await acquireGatewayPermit();
  let reservation: string;
  try {
    reservation = await transaction(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('gateway-budget'))`);
      const status = (
        await c.query("SELECT state FROM matching_campaigns WHERE id=$1", [
          campaign.id,
        ])
      ).rows[0];
      if (status?.state !== "running")
        throw new GatewayDeferred("Matching campaign is paused", "disabled");
      const blocking = (
        await c.query<{ id: string; status: string }>(
          `SELECT id,status FROM ai_usage WHERE request_key=$1 AND status IN ('reserved','uncertain') ORDER BY created_at DESC LIMIT 1`,
          [key],
        )
      ).rows[0];
      if (blocking)
        throw new GatewayDeferred(
          "A previous AI request has no confirmed result; billing reconciliation is needed before repeating it",
          "inflight",
          {
            action: "defer",
            usage_id: blocking.id,
            request_key: key,
            billing: "uncertain",
          },
        );
      const totals = (
        await c.query(
          `SELECT coalesce(sum(cost_usd) FILTER(WHERE campaign_id=$1),0) AS campaign_cost,
      coalesce(sum(cost_usd) FILTER(WHERE campaign_id IN (SELECT id FROM matching_campaigns WHERE kind='initial')),0) AS initial_cost,
      count(*) FILTER(WHERE campaign_id=$1)::int AS campaign_requests,
      coalesce(sum(cost_usd) FILTER(WHERE campaign_id IN (SELECT id FROM matching_campaigns WHERE kind='incremental') AND date_trunc('month',created_at AT TIME ZONE $2)=date_trunc('month',now() AT TIME ZONE $2)),0) AS monthly_cost,
      count(*) FILTER(WHERE campaign_id IN (SELECT id FROM matching_campaigns WHERE kind='incremental') AND date_trunc('month',created_at AT TIME ZONE $2)=date_trunc('month',now() AT TIME ZONE $2))::int AS monthly_requests FROM ai_usage`,
          [campaign.id, settings.app.timezone],
        )
      ).rows[0];
      if (
        (campaign.kind !== "incremental" &&
          new Decimal(
            campaign.kind === "initial"
              ? totals.initial_cost
              : totals.campaign_cost,
          )
            .plus(estimate)
            .gt(budget(campaign))) ||
        totals.campaign_requests >= g.max_requests_per_campaign ||
        (campaign.kind === "incremental" &&
          (new Decimal(totals.monthly_cost)
            .plus(estimate)
            .gt(g.monthly_budget_usd) ||
            totals.monthly_requests >= g.max_requests_per_month))
      )
        throw new GatewayDeferred(
          "Paused: spending or request limit reached",
          "budget",
        );
      const task = taskContext();
      if (task) {
        const used = (
          await c.query(
            `SELECT coalesce(sum(cost_usd),0) AS cost,count(*)::int AS requests FROM ai_usage WHERE task_id=$1`,
            [task.task.id],
          )
        ).rows[0];
        const maxCost = Math.min(
          task.task.options.max_cost_usd,
          task.task.policy.task_budget_usd,
          task.live.policy.task_budget_usd,
        );
        if (
          new Decimal(used.cost).plus(estimate).gt(maxCost) ||
          used.requests >=
            Math.min(
              task.task.policy.task_request_limit,
              task.live.policy.task_request_limit,
            )
        )
          throw new GatewayDeferred(
            "Paused: task spending or request limit reached",
            "budget",
          );
      }
      return (
        await c.query(
          `INSERT INTO ai_usage(campaign_id,endpoint,model,status,input_tokens,output_tokens,cost_usd,request_key,prompt_key,operation,task_id) VALUES($1,$2,$3,'reserved',0,0,$4,$5,$6,$7,$8) RETURNING id`,
          [
            campaign.id,
            endpoint,
            model,
            estimate.toString(),
            key,
            prompt?.key ?? null,
            prompt?.operation ?? kind,
            taskContext()?.task.id ?? null,
          ],
        )
      ).rows[0].id as string;
    });
  } catch (error) {
    await logEvent(
      error instanceof GatewayDeferred
        ? error.reason === "disabled"
          ? "debug"
          : "warn"
        : "error",
      "gateway.request.deferred",
      "AI request was not sent",
      {
        ...trace,
        reason:
          error instanceof GatewayDeferred
            ? error.reason
            : "reservation_failed",
        estimated_cost_usd: estimate.toString(),
        allowance_usd: budget(campaign),
      },
    );
    throw error;
  }
  // Permission removal after reservation must stop the unsent request as well.
  try {
    await checkpoint(true);
    await assertAvailableContext();
    const task = taskContext();
    if (task) {
      const totals = (
        await pool.query(
          `SELECT coalesce(sum(cost_usd) FILTER(WHERE task_id=$1),0) AS task_cost,
        coalesce(sum(cost_usd) FILTER(WHERE campaign_id IN(SELECT id FROM matching_campaigns WHERE kind='initial')),0) AS initial_cost,
        coalesce(sum(cost_usd) FILTER(WHERE campaign_id IN(SELECT id FROM matching_campaigns WHERE kind='incremental') AND date_trunc('month',created_at AT TIME ZONE $2)=date_trunc('month',now() AT TIME ZONE $2)),0) AS monthly_cost FROM ai_usage`,
          [task.task.id, settings.app.timezone],
        )
      ).rows[0];
      const now = matchingConfig().gateway;
      if (
        Number(totals.task_cost) >
          Math.min(
            task.task.options.max_cost_usd,
            task.live.policy.task_budget_usd,
          ) ||
        (campaign.kind === "initial" &&
          Number(totals.initial_cost) > now.initial_budget_usd) ||
        (campaign.kind === "incremental" &&
          Number(totals.monthly_cost) > now.monthly_budget_usd)
      )
        throw new GatewayDeferred(
          "Paused: spending allowance reduced",
          "budget",
        );
    }
  } catch (error) {
    await pool.query(
      `UPDATE ai_usage SET status='rejected',cost_usd=0 WHERE id=$1`,
      [reservation],
    );
    throw error;
  }
  let generation: string | null = null;
  let httpStatus: number | null = null;
  let rejectionRecorded = false;
  let failurePhase = "request";
  const started = Date.now();
  await logEvent("debug", "gateway.request.started", "AI request started", {
    ...trace,
    usage_id: reservation,
    estimated_cost_usd: estimate.toString(),
    input_bytes: bytes,
    questions,
  });
  try {
    const response = await fetch(new URL(endpoint, g.base_url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${g.api_key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(g.timeout_ms),
    });
    httpStatus = response.status;
    failurePhase = "response_body";
    const raw = await response.text();
    failurePhase = "http_status";
    if (!response.ok) {
      // Explicit rejection is not an ambiguous transport failure. A request that
      // may have executed keeps its reservation, preventing blind paid retries.
      if ([400, 401, 402, 403, 404, 413, 422, 429].includes(response.status)) {
        await pool.query(
          `UPDATE ai_usage SET status='rejected',cost_usd=0 WHERE id=$1`,
          [reservation],
        );
        rejectionRecorded = true;
      }
      throw new GatewayDeferred(
        response.status === 429
          ? "AI service rate limit reached (HTTP 429). Resume later; saved results are kept."
          : [401, 402, 403, 404].includes(response.status)
            ? `AI Gateway access, credits or model configuration needs attention (HTTP ${response.status}).`
            : `AI request failed (HTTP ${response.status}); this product needs recovery.`,
        "provider",
        {
          action:
            response.status === 429 && rejectionRecorded
              ? "retry"
              : [401, 402, 403, 404].includes(response.status)
                ? "pause"
                : "defer",
          usage_id: reservation,
          request_key: key,
          http_status: response.status,
          billing: rejectionRecorded ? "rejected" : "uncertain",
        },
      );
    }
    failurePhase = "response_json";
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const metadata = parsed.providerMetadata as
      | { gateway?: { cost?: string | number; generationId?: string } }
      | undefined;
    generation =
      metadata?.gateway?.generationId ??
      (typeof parsed.id === "string" ? parsed.id : null);
    const usage = parsed.usage as Record<string, unknown> | undefined;
    failurePhase = "usage_receipt";
    const input = tokenCount.parse(
      kind === "decision" ? usage?.inputTokens : usage?.prompt_tokens,
    );
    const output = tokenCount.parse(
      kind === "decision" ? usage?.outputTokens : usage?.completion_tokens,
    );
    const charge = kind === "decision" ? metadata?.gateway?.cost : usage?.cost;
    if (
      (typeof charge !== "string" && typeof charge !== "number") ||
      !new Decimal(charge).isFinite() ||
      new Decimal(charge).isNegative()
    )
      throw new Error("Missing or invalid Gateway charge");
    const cost = new Decimal(charge).toString();
    const normalized = {
      ...parsed,
      __accounting: {
        input_tokens: input,
        output_tokens: output,
        cost_usd: cost,
        generation_id: generation,
      },
      __cached: false,
    };
    failurePhase = "save_receipt";
    await transaction(async (c) => {
      await c.query(
        `UPDATE ai_usage SET status='success',input_tokens=$2,output_tokens=$3,cost_usd=$4,generation_id=$5,http_status=200,failure_phase=NULL WHERE id=$1`,
        [reservation, input, output, cost, generation],
      );
      await c.query(
        "INSERT INTO ai_cache(key,result) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [key, JSON.stringify(normalized)],
      );
    });
    await logEvent(
      "debug",
      "gateway.request.completed",
      "AI request completed",
      {
        ...trace,
        usage_id: reservation,
        generation_id: generation,
        input_tokens: input,
        output_tokens: output,
        cost_usd: cost,
        duration_ms: Date.now() - started,
      },
    );
    return normalized;
  } catch (error) {
    const rejected = rejectionRecorded;
    try {
      await pool.query(
        `UPDATE ai_usage SET status=CASE WHEN status='reserved' THEN 'uncertain' ELSE status END,generation_id=coalesce(generation_id,$2),http_status=$3,failure_phase=$4 WHERE id=$1 AND status IN ('reserved','rejected')`,
        [reservation, generation, httpStatus, failurePhase],
      );
    } finally {
      // Never log response bodies, prompts, headers or raw transport exceptions.
      await logEvent(
        rejected ? "warn" : "error",
        "gateway.request.failed",
        rejected
          ? "AI provider rejected the request"
          : "AI request failed; billing needs attention",
        {
          ...trace,
          usage_id: reservation,
          generation_id: generation,
          http_status: httpStatus,
          billing_status: rejected ? "rejected" : "uncertain",
          reservation_retained: !rejected || !rejectionRecorded,
          failure_phase: failurePhase,
          duration_ms: Date.now() - started,
        },
      );
    }
    if (error instanceof GatewayDeferred) throw error;
    throw new GatewayDeferred(
      "Gateway response or connection needs attention; reservation retained",
      "provider",
      {
        action:
          httpStatus !== null && [401, 402, 403, 404, 429].includes(httpStatus)
            ? "pause"
            : "defer",
        usage_id: reservation,
        request_key: key,
        http_status: httpStatus,
        billing: "uncertain",
      },
    );
  }
}
// Explicit research entry point: the request layer refuses model overrides in
// application databases. Experiments share production caching and accounting.
export async function extractionExperiment(
  campaign: Campaign,
  body: Record<string, unknown>,
  profile: {
    model: string;
    input_per_million: number;
    output_per_million: number;
  },
) {
  return request(campaign, "extraction", body, profile);
}

export async function decide(
  campaign: Campaign,
  state: unknown,
  questions: Questions,
  details: Record<string, unknown> = {},
  prompt?: PromptBundle,
): Promise<GatewayResult> {
  return withLogContext(
    { data: { ...details, campaign_id: campaign.id } },
    () => decideScoped(campaign, state, questions, prompt),
  );
}
async function decideScoped(
  campaign: Campaign,
  state: unknown,
  questions: Questions,
  prompt?: PromptBundle,
): Promise<GatewayResult> {
  const payload = await request(
    campaign,
    "decision",
    { state, questions },
    undefined,
    prompt,
  );
  const answers: Record<string, ChoiceAnswer> = {};
  const raw = payload.answers as Record<string, unknown> | undefined;
  for (const [id, question] of Object.entries(questions)) {
    const answer = choiceSchema.safeParse(raw?.[id]);
    if (
      !answer.success ||
      !(answer.data.choice in question.criteria) ||
      Object.keys(question.criteria).some(
        (k) => answer.data.probabilities[k] === undefined,
      )
    ) {
      await logEvent(
        "warn",
        "gateway.decision.invalid",
        "AI decision response failed validation",
        { question_id: id },
      );
      throw new GatewayDeferred(
        "Invalid decision response; no connection saved",
        "invalid",
      );
    }
    const probabilities = Object.entries(answer.data.probabilities);
    if (
      probabilities.some(([key]) => !(key in question.criteria)) ||
      Math.abs(probabilities.reduce((sum, [, p]) => sum + p, 0) - 1) > 1e-6 ||
      probabilities.some(
        ([, p]) => p > answer.data.probabilities[answer.data.choice],
      )
    ) {
      await logEvent(
        "warn",
        "gateway.decision.invalid",
        "AI decision probabilities were inconsistent",
        { question_id: id },
      );
      throw new GatewayDeferred(
        "Decision probabilities are inconsistent; no connection saved",
        "invalid",
      );
    }
    answers[id] = {
      ...answer.data,
      confidence: answer.data.confidence ?? null,
    };
  }
  const a = payload.__accounting as {
    input_tokens: number;
    output_tokens: number;
    cost_usd: string;
    generation_id: string | null;
  };
  return {
    model: matchingConfig().gateway.decision_model,
    answers,
    ...a,
    cached: payload.__cached === true,
    prompt_key: prompt?.key ?? null,
  };
}
export async function classificationRequest(
  product: StoreProduct,
  c?: Pick<PoolClient, "query">,
) {
  // Category inputs must not depend on a previous model answer or later Qwen
  // enrichment, otherwise the classification would invalidate its own cache.
  const ruleFamily = familyFromText(
    product,
    product.retailer,
    matchingConfig().category_mappings,
  );
  const { id: _id, ...source } = requestProduct({
    ...product,
    family: ruleFamily,
    facts: refreshProductFacts(
      {
        ...product,
        manual_family: null,
        classified_family: null,
        family: ruleFamily,
        facts: {},
      },
      await matchingRules(c, product.retailer),
      matchingConfig().category_mappings,
    ).facts,
  });
  const prompt = matchingPrompts.bundle(
    "classification",
    [product.retailer],
    [],
  );
  const state = { product: source };
  // Category freshness follows the same source facts and prompt, rather than
  // presentation improvements. Provider response caching still hashes the full
  // actual payload in request(), including every readable field.
  const identityState = classificationSource(product);
  const questions: Questions = {
    family: {
      type: "choice",
      instructions: prompt.instructions,
      criteria: matchingPrompts.categories,
    },
  };
  const previous = product.classification_key
    ? (
        await (c ?? pool).query<{
          source: unknown;
          model: string;
          prompt_key: string;
        }>(
          "SELECT source,model,prompt_key FROM classification_source_snapshots WHERE store_product_id=$1 AND input_key=$2",
          [product.id, product.classification_key],
        )
      ).rows[0]
    : null;
  const savedKey =
    previous &&
    hash(previous.source) === hash(identityState) &&
    previous.model === matchingConfig().gateway.decision_model &&
    previous.prompt_key === prompt.key
      ? product.classification_key
      : null;
  return {
    state,
    questions,
    prompt,
    key:
      savedKey ??
      hash([
        matchingConfig().gateway.base_url,
        matchingConfig().gateway.decision_model,
        identityState,
        questions,
        prompt.key,
      ]),
  };
}
export async function classify(campaign: Campaign, product: StoreProduct) {
  const plan = await classificationRequest(product);
  const result = await withAvailableProducts([product.id], product.id, () =>
    decide(
      campaign,
      plan.state,
      plan.questions,
      {
        operation: "classify",
        store_product_id: product.id,
        retailer: product.retailer,
      },
      plan.prompt,
    ),
  );
  const answer = result.answers.family;
  const hints = Object.entries(answer.probabilities)
    .filter(
      ([id, probability]) =>
        probability > 0 && families.includes(id as Family) && id !== "unknown",
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([id]) => id as Family);
  return {
    key: plan.key,
    family: (answer.probabilities[answer.choice] >=
    matchingConfig().category_threshold
      ? answer.choice
      : "unknown") as Family,
    hints,
    result,
  };
}
export async function compare(
  campaign: Campaign,
  query: StoreProduct,
  candidates: Candidate[],
) {
  const all = [
    query,
    ...candidates.flatMap((c) => [
      c.product,
      ...c.members.filter((m) => m.availability === "available"),
    ]),
  ];
  const prompt = matchingPrompts.bundle(
    "comparison",
    all.map((p) => p.retailer),
    all.map((p) => p.family),
  );
  const questions: Questions = {};
  for (let i = 0; i < candidates.length; i++) {
    questions[`candidate_${i}`] = {
      type: "choice",
      instructions: matchingPrompts.question.replaceAll(
        "{{candidate}}",
        `candidate_${i}`,
      ),
      criteria: matchingPrompts.answers,
    };
    if (identityGaps(query, candidates[i].product, identityCatalog).length)
      questions[`detail_${i}`] = {
        type: "choice",
        instructions: `For candidate_${i}, choose the most important identity detail whose supplied source text could usefully be interpreted. Choose missing_from_source if a material distinction is not supplied. Choose none if the supplied identity evidence is already sufficient. A missing database brand ID is not missing source information.`,
        criteria: identityCatalog.routing,
      };
  }
  const result = await withAvailableProducts(
    all.map((p) => p.id),
    query.id,
    () =>
      decide(
        campaign,
        {
          comparison_instructions: prompt.instructions,
          identity_requirements: identityCatalog.profiles
            .filter((profile) =>
              all.some((p) =>
                profile.types.includes(p.facts.type?.value ?? ""),
              ),
            )
            .map(({ id, required, identity_any }) => ({
              profile: id,
              required,
              identity_any,
            })),
          query: query.id,
          products: Object.fromEntries(
            [...new Map(all.map((p) => [p.id, p])).values()].map((p) => [
              p.id,
              identityRequest(p, identityCatalog),
            ]),
          ),
          candidates: Object.fromEntries(
            candidates.map((candidate, i) => [
              `candidate_${i}`,
              {
                representative: candidate.product.id,
                members: candidate.members
                  .filter((p) => p.availability === "available")
                  .map((p) => p.id),
              },
            ]),
          ),
        },
        questions,
        {
          operation: "compare",
          store_product_id: query.id,
          retailer: query.retailer,
          candidate_ids: candidates.map((c) => c.product.id),
        },
        prompt,
      ),
  );
  return candidates.map((candidate, i) => ({
    candidate,
    answer: result.answers[`candidate_${i}`],
    clarification: result.answers[`detail_${i}`] ?? null,
    result,
  }));
}

export const clarificationSchema = z
  .object({
    facts: z.array(
      z
        .object({
          field: z.enum(factNames),
          literal: z.string().min(1),
          quote: z.string().min(1),
          source: z.enum(["name", "description", "category", "gtin"]),
        })
        .strict(),
    ),
    missing: z.array(z.enum(factNames)),
  })
  .strict();
export async function clarify(
  campaign: Campaign,
  product: StoreProduct,
  fields: readonly string[],
): Promise<Facts> {
  return withLogContext(
    {
      data: {
        campaign_id: campaign.id,
        store_product_id: product.id,
        retailer: product.retailer,
        operation: "clarify",
      },
    },
    async () => {
      try {
        return await withAvailableProducts([product.id], product.id, () =>
          clarifyScoped(campaign, product, fields),
        );
      } catch (error) {
        if (error instanceof GatewayDeferred && error.reason === "invalid")
          await logEvent(
            "warn",
            "gateway.clarification.rejected",
            "AI clarification did not pass source checks",
            { fields, reason: error.message },
          );
        throw error;
      }
    },
  );
}
export function clarificationMessages(
  product: StoreProduct,
  allowed: readonly string[],
) {
  return [
    {
      role: "system",
      content: `${matchingPrompts.bundle("clarification", [product.retailer], [product.family]).instructions}\nRequested fields: ${allowed.join(", ")}.`,
    },
    {
      role: "user",
      content: JSON.stringify(identityRequest(product, identityCatalog)),
    },
  ];
}
async function clarifyScoped(
  campaign: Campaign,
  product: StoreProduct,
  fields: readonly string[],
): Promise<Facts> {
  const allowed = fields.filter((f) =>
    factNames.includes(f as (typeof factNames)[number]),
  );
  const boundedSchema = clarificationSchema.extend({
    facts: z.array(
      clarificationSchema.shape.facts.element.extend({
        field: z.enum(
          allowed as [
            (typeof factNames)[number],
            ...(typeof factNames)[number][],
          ],
        ),
      }),
    ),
    missing: z.array(
      z.enum(
        allowed as [
          (typeof factNames)[number],
          ...(typeof factNames)[number][],
        ],
      ),
    ),
  });
  const schema = z.toJSONSchema(boundedSchema);
  delete schema.$schema;
  const result = await request(
    campaign,
    "extraction",
    {
      messages: clarificationMessages(product, allowed),
      temperature: 0,
      stream: false,
      reasoning: { enabled: matchingConfig().gateway.reasoning_enabled },
      max_tokens: matchingConfig().gateway.max_output_tokens,
      response_format: {
        type: "json_schema",
        json_schema: { name: "supported_product_facts", strict: true, schema },
      },
      providerOptions: { gateway: { only: ["alibaba"] } },
    },
    undefined,
    matchingPrompts.bundle(
      "clarification",
      [product.retailer],
      [product.family],
    ),
  );
  const choices = result.choices as
    { message?: { content?: string } }[] | undefined;
  let parsed: z.infer<typeof clarificationSchema>;
  try {
    parsed = clarificationSchema.parse(
      JSON.parse(choices?.[0]?.message?.content ?? ""),
    );
  } catch {
    throw new GatewayDeferred(
      "Clarification format is invalid; product kept separate",
      "invalid",
    );
  }
  const { facts, rejected } = validateClarification(
    product,
    parsed.facts.map(({ literal, ...fact }) => ({ ...fact, value: literal })),
    allowed,
    await matchingRules(undefined, product.retailer),
    identityCatalog,
  );
  if (rejected.length) {
    await logEvent(
      "warn",
      "gateway.clarification.fields_rejected",
      "Unsupported AI facts were discarded; validated facts were retained",
      {
        rejected_fields: rejected,
        retained_fields: Object.keys(facts),
      },
    );
    if (!Object.keys(facts).length)
      throw new GatewayDeferred(rejected[0].reason, "invalid");
  }
  await logEvent(
    "debug",
    "gateway.clarification.validated",
    "AI clarification passed source checks",
    { fields: Object.keys(facts), missing_fields: parsed.missing },
  );
  return facts;
}

export const llmCategorySchema = z.strictObject({
  category: z.enum(families),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(settings.product_details.note_max_length),
  quote: z.string().max(settings.product_details.note_max_length),
});
// Uses the same production request boundary as matching clarification: cache,
// reservations, live permissions, task caps and cooldowns are shared.
export async function reviewCategoryWithLlm(
  campaign: Campaign,
  product: StoreProduct,
) {
  const prompt = matchingPrompts.bundle("llm_review", [product.retailer], []);
  const plan = await classificationRequest(product);
  const schema = z.toJSONSchema(llmCategorySchema);
  delete schema.$schema;
  const result = await withAvailableProducts([product.id], product.id, () =>
    request(
      campaign,
      "extraction",
      {
        messages: [
          {
            role: "system",
            content: `${prompt.instructions}\nCategory definitions:\n${JSON.stringify(matchingPrompts.reviewCategories)}`,
          },
          { role: "user", content: JSON.stringify(plan.state) },
        ],
        temperature: 0,
        stream: false,
        reasoning: { enabled: settings.llm_review.reasoning_enabled },
        max_tokens: settings.llm_review.max_output_tokens,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "product_category_review",
            strict: true,
            schema,
          },
        },
        providerOptions: { gateway: { only: ["alibaba"] } },
      },
      undefined,
      prompt,
    ),
  );
  const choices = result.choices as
    { message?: { content?: string } }[] | undefined;
  const parsed = llmCategorySchema.safeParse(
    (() => {
      try {
        return JSON.parse(choices?.[0]?.message?.content ?? "");
      } catch {
        return null;
      }
    })(),
  );
  if (!parsed.success)
    throw new GatewayDeferred(
      "LLM review response is invalid; category kept for review",
      "invalid",
    );
  const answer = parsed.data;
  const source = plan.state.product as Record<string, unknown>;
  const texts = [
    source.name,
    source.readable_name,
    source.description,
    source.readable_description,
    source.category,
    source.readable_category,
  ].filter((v): v is string => typeof v === "string");
  if (
    answer.category !== "unknown" &&
    (!answer.quote.trim() || !texts.some((t) => t.includes(answer.quote)))
  )
    throw new GatewayDeferred(
      "LLM supporting quote is missing from the supplied source; category kept for review",
      "invalid",
    );
  return {
    ...answer,
    model: matchingConfig().gateway.extraction_model,
    prompt_key: prompt.key,
    generation_id: (result.__accounting as { generation_id: string | null })
      .generation_id,
  };
}
