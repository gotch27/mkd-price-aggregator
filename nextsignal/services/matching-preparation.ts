import { settings } from "@/nextsignal/config";
import { hash } from "@/nextsignal/domain/normalize";
import {
  prepareIdentity,
  identityFields,
  identityDifferences,
  type IdentityProduct,
} from "@/nextsignal/domain/matching-identity";
import type { StoreProduct, Facts } from "@/nextsignal/domain/matching";
import type { TaskExecution } from "@/nextsignal/domain/task-settings";
import { pool, transaction } from "./database";
import { matchingRules } from "./brand-catalog";
import { identityCatalog } from "./identity-catalog";
import * as repository from "./matching-repository";
import { clarify, GatewayDeferred } from "./ai-gateway";
import { checkpoint, taskContext, matchingConfig } from "./task-context";
import { logEvent } from "@/nextsignal/adapters/log-context";
import { assertProductAvailable } from "./product-availability";
import { matchingPrompts } from "./matching-prompts";

type SavedPreparation = {
  facts: Facts;
  attempted: boolean;
  requested_fields: string[];
  reason: string;
};
const preparationKey = (p: IdentityProduct) =>
  hash([
    p.identity!.key,
    matchingConfig().gateway.base_url,
    matchingConfig().gateway.extraction_model,
    matchingPrompts.bundle("clarification", [p.retailer], [p.family]).key,
  ]);
export async function needsIdentityInterpretation(
  product: StoreProduct,
  peers: StoreProduct[],
) {
  const p = prepareIdentity(
    product,
    await matchingRules(undefined, product.retailer),
    matchingConfig().category_mappings,
    identityCatalog,
  );
  const previous = (
    await pool.query<SavedPreparation>(
      "SELECT attempted,requested_fields FROM matching_product_preparations WHERE store_product_id=$1 AND input_key=$2",
      [p.id, preparationKey(p)],
    )
  ).rows[0];
  return identityFields(p, identityCatalog, peers).some(
    (f) => !previous?.attempted || !previous.requested_fields.includes(f),
  );
}
export async function planCounterparts(task: TaskExecution, ids: string[]) {
  if (!task.options.use_ai) return;
  const scored = new Map<string, { rank: number; hits: number }>();
  const primary = new Set(
    (
      await pool.query<{ store_product_id: string }>(
        "SELECT store_product_id FROM task_items WHERE task_id=$1",
        [task.id],
      )
    ).rows.map((p) => p.store_product_id),
  );
  for (const id of [...ids].sort()) {
    await checkpoint();
    const p = await repository.getProduct(id),
      rules = await matchingRules(undefined, p.retailer);
    const prepared = prepareIdentity(
      p,
      rules,
      matchingConfig().category_mappings,
      identityCatalog,
    );
    const candidates = await repository.findCandidates(prepared, "ai");
    let rank = 0;
    for (const candidate of candidates) {
      if (
        identityDifferences(prepared, candidate.product, identityCatalog)
          .length ||
        candidate.members.every(
          (m) => !identityFields(m, identityCatalog, [prepared]).length,
        )
      )
        continue;
      for (const member of candidate.members) {
        if (
          primary.has(member.id) ||
          !identityFields(member, identityCatalog, [prepared]).length
        )
          continue;
        const previous = (
          await pool.query<SavedPreparation>(
            "SELECT attempted,requested_fields FROM matching_product_preparations WHERE store_product_id=$1 AND input_key=$2",
            [
              member.id,
              preparationKey(
                prepareIdentity(
                  member,
                  await matchingRules(undefined, member.retailer),
                  matchingConfig().category_mappings,
                  identityCatalog,
                ),
              ),
            ],
          )
        ).rows[0];
        if (
          previous?.attempted &&
          identityFields(member, identityCatalog, [prepared]).every((f) =>
            previous.requested_fields.includes(f),
          )
        )
          continue;
        if (
          rank >=
          Math.min(
            task.policy.counterparts_per_product,
            taskContext()!.live.policy.counterparts_per_product,
          )
        )
          break;
        rank++;
        const old = scored.get(member.id);
        scored.set(member.id, {
          rank: Math.min(old?.rank ?? rank, rank),
          hits: (old?.hits ?? 0) + 1,
        });
      }
    }
  }
  await transaction(async (c) => {
    await c.query("SELECT id FROM task_executions WHERE id=$1 FOR UPDATE", [
      task.id,
    ]);
    const existing = (
      await c.query<{ store_product_id: string; position: number }>(
        "SELECT store_product_id,position FROM matching_task_preparations WHERE task_id=$1 ORDER BY position",
        [task.id],
      )
    ).rows;
    const seen = new Set(existing.map((p) => p.store_product_id));
    const cap = Math.min(
      task.options.counterpart_limit!,
      task.policy.counterpart_limit,
      taskContext()!.live.policy.counterpart_limit,
    );
    let position = existing.length;
    for (const [id] of [...scored].sort(
      (a, b) =>
        a[1].rank - b[1].rank ||
        b[1].hits - a[1].hits ||
        a[0].localeCompare(b[0]),
    )) {
      if (seen.has(id) || position >= cap) continue;
      await c.query(
        "INSERT INTO matching_task_preparations(task_id,store_product_id,position) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [task.id, id, position++],
      );
    }
    await c.query(
      "UPDATE task_executions SET checkpoint=checkpoint||jsonb_build_object('matching_phase','preparing','counterparts_planned',$2::int) WHERE id=$1",
      [task.id, position],
    );
  });
}
export async function prepareForMatching(
  product: StoreProduct,
  campaign: repository.Campaign,
  interpret: boolean,
  counterpart = false,
  peers: StoreProduct[] = [],
): Promise<{ product: IdentityProduct; limited: boolean }> {
  const rules = await matchingRules(undefined, product.retailer);
  let p = prepareIdentity(
    product,
    rules,
    matchingConfig().category_mappings,
    identityCatalog,
  );
  const sourceKey = p.identity!.key;
  const key = preparationKey(p);
  const saved = (
    await pool.query<SavedPreparation>(
      "SELECT facts,attempted,requested_fields,reason FROM matching_product_preparations WHERE store_product_id=$1 AND input_key=$2",
      [p.id, key],
    )
  ).rows[0];
  if (saved)
    p = prepareIdentity(
      { ...p, facts: { ...saved.facts, ...p.facts } },
      rules,
      matchingConfig().category_mappings,
      identityCatalog,
    );
  const fields = identityFields(p, identityCatalog, peers).filter(
    (f) => !saved?.attempted || !saved.requested_fields.includes(f),
  );
  const context = taskContext();
  const canInterpret =
    interpret &&
    matchingConfig().gateway.enabled &&
    (!context ||
      (context.task.policy.clarification_enabled &&
        context.live.policy.clarification_enabled));
  let limited = false,
    attempted = saved?.attempted ?? false,
    reason = saved?.reason ?? "Prepared from source rules";
  let requested = saved?.requested_fields ?? [];
  if (fields.length && canInterpret) {
    let allowed = true;
    if (counterpart && context) {
      const primary = (
        await pool.query(
          "SELECT 1 FROM task_items WHERE task_id=$1 AND store_product_id=$2",
          [context.task.id, p.id],
        )
      ).rowCount;
      if (!primary) {
        allowed = await transaction(async (c) => {
          await c.query(
            "SELECT id FROM task_executions WHERE id=$1 FOR UPDATE",
            [context.task.id],
          );
          const cap = Math.min(
            context.task.options.counterpart_limit!,
            context.task.policy.counterpart_limit,
            context.live.policy.counterpart_limit,
          );
          return !!(
            await c.query(
              "UPDATE matching_task_preparations SET consumed=true,fields_key=coalesce(fields_key,$4) WHERE task_id=$1 AND store_product_id=$2 AND position<$3 AND (fields_key IS NULL OR fields_key=$4) RETURNING store_product_id",
              [context.task.id, p.id, cap, hash([...fields].sort())],
            )
          ).rowCount;
        });
      }
    }
    if (!allowed) {
      limited = true;
      reason = "Counterpart interpretation allowance reached";
    } else {
      await checkpoint(true);
      await assertProductAvailable(p.id);
      await phase("preparing", p.id);
      // Save an attempted marker only for a validated response/abstention. The
      // Gateway's durable reservation protects interrupted, possibly billed calls.
      try {
        const facts = await clarify(campaign, p, fields);
        p = prepareIdentity(
          { ...p, facts: { ...p.facts, ...facts } },
          rules,
          matchingConfig().category_mappings,
          identityCatalog,
        );
        attempted = true;
        requested = [...new Set([...requested, ...fields])];
        reason = "Source interpretation saved";
      } catch (error) {
        if (!(error instanceof GatewayDeferred) || error.reason !== "invalid")
          throw error;
        attempted = true;
        requested = [...new Set([...requested, ...fields])];
        reason = error.message;
      }
    }
  }
  await checkpoint();
  const live = await repository.getProduct(p.id);
  if (
    prepareIdentity(
      live,
      rules,
      matchingConfig().category_mappings,
      identityCatalog,
    ).identity!.key !== sourceKey
  )
    throw new GatewayDeferred(
      "Product changed during identity preparation; review the current source revision",
      "invalid",
    );
  const stored = (
    await pool.query<{ facts: Facts }>(
      "SELECT facts FROM store_products WHERE id=$1",
      [p.id],
    )
  ).rows[0];
  if (hash(stored.facts) !== hash(p.facts))
    p = prepareIdentity(
      await repository.saveFacts(live, p.facts, p.family, p.category_hints),
      rules,
      matchingConfig().category_mappings,
      identityCatalog,
    );
  if (p.identity!.key !== sourceKey)
    throw new GatewayDeferred(
      "Product changed while identity facts were being saved; review the current source revision",
      "invalid",
    );
  await pool.query(
    `INSERT INTO matching_product_preparations(store_product_id,input_key,profile,facts,statuses,requested_fields,attempted,outcome,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(store_product_id,input_key) DO UPDATE SET facts=excluded.facts,statuses=excluded.statuses,requested_fields=excluded.requested_fields,attempted=matching_product_preparations.attempted OR excluded.attempted,outcome=excluded.outcome,reason=excluded.reason,updated_at=now()`,
    [
      p.id,
      key,
      p.identity!.profile,
      p.facts,
      p.identity!.statuses,
      JSON.stringify(requested),
      attempted,
      limited ? "limited" : fields.length ? "prepared" : "complete",
      reason,
    ],
  );
  await logEvent(
    "debug",
    "matching.identity.prepared",
    "Matching identity prepared",
    {
      store_product_id: p.id,
      profile: p.identity!.profile,
      attempted,
      cached: !!saved,
      limited,
    },
  );
  return { product: p, limited };
}
export async function phase(name: string, id?: string) {
  const ctx = taskContext();
  if (!ctx) return;
  await pool.query(
    "UPDATE task_executions SET checkpoint=checkpoint||jsonb_build_object('matching_phase',$2::text,'matching_product',$3::text),updated_at=now() WHERE id=$1",
    [ctx.task.id, name, id ?? null],
  );
}
