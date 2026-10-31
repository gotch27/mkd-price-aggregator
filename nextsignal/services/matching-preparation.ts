import { hash } from "@/nextsignal/domain/normalize";
import {
  prepareIdentity,
  identityFields,
  type IdentityProduct,
} from "@/nextsignal/domain/matching-identity";
import type {
  StoreProduct,
  Facts,
  FactName,
} from "@/nextsignal/domain/matching";
import { pool, transaction } from "./database";
import { matchingRules } from "./brand-catalog";
import { identityCatalog } from "./identity-catalog";
import * as repository from "./matching-repository";
import { clarify, GatewayDeferred, GatewayInputTooLarge } from "./ai-gateway";
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
  requestedFields?: readonly FactName[],
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
    (f) =>
      (!requestedFields || requestedFields.includes(f)) &&
      (!previous?.attempted || !previous.requested_fields.includes(f)),
  );
}
// Allocate only after a useful Decider response. Claims survive restarts.
export async function allocateCounterpart(primaryId: string, targetId: string) {
  const context = taskContext();
  if (!context) return true;
  await checkpoint(true);
  return transaction(async (c) => {
    const { task, live } = context;
    await c.query("SELECT id FROM task_executions WHERE id=$1 FOR UPDATE", [
      task.id,
    ]);
    const existing = (
      await c.query(
        "SELECT 1 FROM matching_primary_preparations WHERE task_id=$1 AND primary_id=$2 AND store_product_id=$3",
        [task.id, primaryId, targetId],
      )
    ).rowCount;
    const used = (
      await c.query(
        "SELECT count(*)::int count FROM matching_primary_preparations WHERE task_id=$1 AND primary_id=$2",
        [task.id, primaryId],
      )
    ).rows[0].count;
    if (
      !existing &&
      used >=
        Math.min(
          task.policy.counterparts_per_product,
          live.policy.counterparts_per_product,
        )
    )
      return false;
    const primary = (
      await c.query(
        "SELECT 1 FROM task_items WHERE task_id=$1 AND store_product_id=$2",
        [task.id, targetId],
      )
    ).rowCount;
    if (!primary) {
      const found = (
        await c.query(
          "SELECT position FROM matching_task_preparations WHERE task_id=$1 AND store_product_id=$2",
          [task.id, targetId],
        )
      ).rows[0];
      const count = (
        await c.query(
          "SELECT count(*)::int count FROM matching_task_preparations WHERE task_id=$1",
          [task.id],
        )
      ).rows[0].count;
      const cap = Math.min(
        task.options.counterpart_limit!,
        task.policy.counterpart_limit,
        live.policy.counterpart_limit,
      );
      if (found ? found.position >= cap : count >= cap) return false;
      if (!found)
        await c.query(
          "INSERT INTO matching_task_preparations(task_id,store_product_id,position) VALUES($1,$2,$3)",
          [task.id, targetId, count],
        );
    }
    await c.query(
      "INSERT INTO matching_primary_preparations(task_id,primary_id,store_product_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [task.id, primaryId, targetId],
    );
    await c.query(
      "UPDATE task_executions SET checkpoint=checkpoint||jsonb_build_object('counterparts_planned',(SELECT count(*)::int FROM matching_task_preparations WHERE task_id=$1)) WHERE id=$1",
      [task.id],
    );
    return true;
  });
}
export async function prepareForMatching(
  product: StoreProduct,
  campaign: repository.Campaign,
  interpret: boolean,
  counterpart = false,
  peers: StoreProduct[] = [],
  requestedFields?: readonly FactName[],
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
    (f) =>
      (!requestedFields || requestedFields.includes(f)) &&
      (!saved?.attempted || !saved.requested_fields.includes(f)),
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
      const beforeRequest = await repository.getProduct(p.id);
      if (
        prepareIdentity(
          beforeRequest,
          rules,
          matchingConfig().category_mappings,
          identityCatalog,
        ).identity!.key !== sourceKey
      )
        throw new GatewayDeferred(
          "Product changed before identity interpretation; review the current source revision",
          "invalid",
        );
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
        // A local size rejection is not a model abstention and must not poison
        // the durable "already interpreted" cache for these source fields.
        if (error instanceof GatewayInputTooLarge) throw error;
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
