import { matchingRules, withBrandCatalog } from "./brand-catalog";
import type { PoolClient } from "pg";
import { pool, transaction } from "./database";
import { settings } from "@/nextsignal/config";
import {
  families,
  familyFromText,
  refreshProductFacts,
  type Family,
  type StoreProduct,
} from "@/nextsignal/domain/matching";
import { hash } from "@/nextsignal/domain/normalize";
import type { ProductClassification } from "@/nextsignal/domain/dashboard";
import type {
  CategoryEditInput,
  CategoryEditView,
} from "@/nextsignal/domain/product-categories";
import { classificationRequest } from "./ai-gateway";
import {
  readGroup,
  knownConflict,
  ProductGroupConflict,
} from "./store-product-groups";
import { grantChangedProducts } from "./task-automation";
import { logEvent } from "@/nextsignal/adapters/log-context";
import { categoryScores } from "@/nextsignal/domain/category-scores";

export async function classificationViews(
  ids: string[],
  c: Pick<PoolClient, "query"> = pool,
) {
  return withBrandCatalog(() => classificationViewsScoped(ids, c), c);
}
async function classificationViewsScoped(
  ids: string[],
  c: Pick<PoolClient, "query">,
) {
  const rows = (
    await c.query<
      StoreProduct & {
        classification_id: string | null;
        model_category: string | null;
        selected_family: string | null;
        probability: string | null;
        acceptance_threshold: string | null;
        probabilities: unknown;
      }
    >(
      `SELECT sp.*,c.id AS classification_id,c.family AS model_category,c.selected_family,c.probability,c.acceptance_threshold,c.probabilities
    FROM store_products sp LEFT JOIN LATERAL (
      SELECT id,family,selected_family,probability,acceptance_threshold,probabilities FROM store_product_classifications
      WHERE store_product_id=sp.id AND input_key=sp.classification_key AND acceptance_threshold=sp.classification_threshold
      ORDER BY created_at DESC,id LIMIT 1
    ) c ON true WHERE sp.id=ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  return new Map(
    await Promise.all(
      rows.map(async (row) => {
        const plan = await classificationRequest(row, c),
          recorded = row.classification_id !== null,
          current = recorded && row.classification_key === plan.key;
        const view: ProductClassification = {
          classification_id: row.classification_id,
          options: categoryScores(row.probabilities, row.selected_family),
          state:
            row.manual_family != null
              ? row.category_review_source === "agent"
                ? "agent"
                : row.category_review_source === "llm"
                  ? "llm"
                  : "manual"
              : !recorded
                ? "not_categorized"
                : !current
                  ? "outdated"
                  : row.model_category === "unknown"
                    ? "uncertain"
                    : "assigned",
          category: row.manual_family ?? row.model_category,
          manual_category: row.manual_family ?? null,
          source:
            row.manual_family != null
              ? (row.category_review_source ?? "human")
              : recorded
                ? "decision_model"
                : null,
          reviewed_by: row.category_review_actor ?? null,
          reviewed_at: row.category_reviewed_at ?? null,
          review_reason: row.category_review_reason ?? null,
          model_category: row.model_category,
          suggested_category: row.selected_family,
          probability:
            row.probability === null ? null : Number(row.probability),
          threshold:
            row.acceptance_threshold === null
              ? null
              : Number(row.acceptance_threshold),
          can_accept_suggestion:
            row.manual_family == null &&
            current &&
            row.model_category === "unknown" &&
            row.selected_family !== null &&
            row.selected_family !== "unknown",
          snapshot: hash([
            row.id,
            row.group_id,
            row.version,
            row.manual_family,
            row.category_review_source,
            row.classification_key,
            row.classification_threshold,
            plan.key,
          ]),
        };
        return [row.id, view] as const;
      }),
    ),
  );
}

export async function readCategory(
  id: string,
  memberId: string,
): Promise<CategoryEditView | null> {
  return transaction(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const group = await readGroup(c, id, true),
      member = group?.members.find((p) => p.id === memberId);
    if (!group || !member?.indexed || group.view.limited) return null;
    const classification = (await classificationViews([member.id], c)).get(
      member.id,
    )!;
    const history = (
      await c.query(
        `SELECT id,actor,source,action,before_category,after_category,note,created_at FROM product_category_edits WHERE store_product_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`,
        [member.id, settings.product_details.history_limit],
      )
    ).rows;
    const total = (
      await c.query(
        "SELECT count(*)::int count FROM product_category_edits WHERE store_product_id=$1",
        [member.id],
      )
    ).rows[0].count;
    return {
      id: group.view.id,
      member_id: member.id,
      name: member.name,
      retailer: member.retailer,
      classification,
      categories: families.map((id) => ({
        id,
        label: id.replaceAll("_", " ").replace(/^./, (s) => s.toUpperCase()),
      })),
      history,
      history_total: total,
      note_max_length: settings.product_details.note_max_length,
      timezone: settings.app.timezone,
    };
  });
}

export async function saveCategory(input: CategoryEditInput, actor: string) {
  const context = {
    actor,
    product_id: input.id,
    member_id: input.member_id,
    action: input.action,
  };
  try {
    const result = await transaction((c) =>
      saveCategoryInTransaction(c, input, actor, { source: "human" }),
    );
    const { classification: _classification, ...loggedResult } = result;
    await logEvent(
      result.changed ? "info" : "debug",
      result.changed
        ? "products.category.updated"
        : "products.category.unchanged",
      result.changed
        ? "Product category saved by a person"
        : "Product category already matches the manual choice",
      { ...context, ...loggedResult },
    );
    return { ok: true as const, ...result };
  } catch (error) {
    if (error instanceof ProductGroupConflict) {
      await logEvent(
        "warn",
        "products.category.rejected",
        "Product category change was not saved",
        { ...context, reason: error.message },
      );
      return { ok: false as const, reason: error.message };
    }
    await logEvent(
      "error",
      "products.category.failed",
      "Product category could not be saved",
      context,
      error,
    );
    throw error;
  }
}

// Shared category commit boundary. Agent batches call this inside their session
// transaction, retaining the same locks, conflict checks and automation permissions.
export async function saveCategoryInTransaction(
  c: PoolClient,
  input: CategoryEditInput,
  actor: string,
  origin: {
    source: "human" | "agent" | "llm";
    session_id?: string;
    task_id?: string;
    model?: string;
    prompt_key?: string;
    generation_id?: string | null;
  },
) {
  await c.query(
    "SELECT pg_advisory_xact_lock(hashtext('store-product-group-commit'))",
  );
  const group = await readGroup(c, input.id, true),
    member = group?.members.find((p) => p.id === input.member_id);
  if (!group || !member?.indexed || group.view.limited)
    throw new ProductGroupConflict(
      "Store product is no longer available in this group. Reload its details.",
    );
  await c.query(
    "SELECT id FROM store_products WHERE group_id=$1 ORDER BY id FOR UPDATE",
    [group.view.id],
  );
  const current = (
    await c.query<StoreProduct>(
      "SELECT *,version::int FROM store_products WHERE id=$1",
      [member.id],
    )
  ).rows[0];
  const view = (await classificationViews([member.id], c)).get(member.id)!;
  if (view.snapshot !== input.snapshot)
    throw new ProductGroupConflict(
      "The product or category changed. Reload before saving.",
    );
  if (
    input.action === "set" &&
    (!input.category || !families.includes(input.category as Family))
  )
    throw new ProductGroupConflict("Choose a category from the list.");
  if (input.action === "accept_suggestion" && !view.can_accept_suggestion)
    throw new ProductGroupConflict(
      "This suggestion is no longer available for approval. Reload its details.",
    );
  if (
    origin.source !== "human" &&
    (current.manual_family != null || view.state !== "uncertain")
  )
    throw new ProductGroupConflict(
      "Only products needing review can be labeled by an agent. Human choices are protected.",
    );
  const manual =
    input.action === "reset"
      ? null
      : input.action === "accept_suggestion"
        ? view.suggested_category
        : input.category;
  if (
    (current.manual_family ?? null) === manual &&
    (manual === null ||
      (current.category_review_source ?? "human") === origin.source)
  )
    return {
      changed: false,
      product_id: group.view.id,
      category: current.classified_family ?? null,
      retailer: current.retailer,
      classification: view,
    };
  const modelCurrent =
    current.classification_key ===
    (await classificationRequest(current, c)).key;
  const effective = manual ?? (modelCurrent ? view.model_category : null);
  const after = refreshProductFacts(
    {
      ...current,
      manual_family: manual as Family | null,
      classified_family: effective as Family | null,
      family:
        (effective as Family) ??
        familyFromText(
          current,
          current.retailer,
          settings.matching.category_mappings,
        ),
    },
    await matchingRules(c, current.retailer),
    settings.matching.category_mappings,
  );
  const classificationId =
    (
      await c.query(
        "SELECT id FROM store_product_classifications WHERE store_product_id=$1 AND input_key=$2 AND acceptance_threshold=$3",
        [
          member.id,
          current.classification_key,
          current.classification_threshold,
        ],
      )
    ).rows[0]?.id ?? null;
  await c.query(
    `INSERT INTO product_category_edits(store_product_id,group_id,actor,action,before_manual,after_manual,before_category,after_category,classification_id,note,source,agent_session_id,review_task_id,review_model,review_prompt_key,review_generation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      member.id,
      group.view.id,
      actor,
      input.action,
      current.manual_family ?? null,
      manual,
      current.classified_family ?? null,
      effective,
      classificationId,
      input.note,
      origin.source,
      origin.session_id ?? null,
      origin.task_id ?? null,
      origin.model ?? null,
      origin.prompt_key ?? null,
      origin.generation_id ?? null,
    ],
  );
  await c.query(
    `UPDATE store_products SET manual_family=$2,classified_family=$3,family=$4,facts=$5,local_key=$6,
        category_pending=$7,rules_pending=true,ai_pending=true,version=version+1,updated_at=now(),
        category_review_source=$8,category_review_actor=$9,category_reviewed_at=CASE WHEN $8::text IS NULL THEN NULL ELSE now() END,category_review_reason=$10 WHERE id=$1`,
    [
      member.id,
      manual,
      effective,
      after.family,
      after.facts,
      after.local_key,
      manual === null && !modelCurrent,
      manual === null ? null : origin.source,
      manual === null ? null : actor,
      manual === null ? null : input.note,
    ],
  );
  await c.query(
    `INSERT INTO matching_work(store_product_id,reason) VALUES($1,$2) ON CONFLICT(store_product_id) DO UPDATE
        SET state='pending',campaign_id=NULL,token=NULL,lease_until=NULL,error=NULL,reason=excluded.reason,updated_at=now()`,
    [
      member.id,
      origin.source === "agent"
        ? "Category reviewed by an agent"
        : origin.source === "llm"
          ? "Category reviewed by an LLM"
          : "Category corrected by a person",
    ],
  );
  await grantChangedProducts(c, [member.id], "manual_edit");
  const updated = await readGroup(c, group.view.id, true);
  const conflict = updated
    ? knownConflict(updated.members)
    : "Product group changed";
  await c.query(
    "UPDATE products SET matching_version=matching_version+1,matching_conflict=matching_conflict OR $2 WHERE id=$1",
    [group.view.id, !!conflict],
  );
  if (conflict)
    await c.query(
      "UPDATE store_products SET state='legacy_conflict',last_reason='Category correction changed product details; saved connection needs review' WHERE group_id=$1",
      [group.view.id],
    );
  return {
    changed: true,
    product_id: group.view.id,
    category: effective,
    retailer: current.retailer,
    before: current.classified_family ?? null,
    after: effective,
    conflict: !!conflict,
    classification: (await classificationViews([member.id], c)).get(member.id)!,
  };
}
