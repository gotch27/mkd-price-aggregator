import type { StoreProduct } from "@/nextsignal/domain/matching";
import type { CategoryResult } from "@/nextsignal/domain/task-results";
import type { TaskExecution } from "@/nextsignal/domain/task-settings";
import type { Campaign } from "./matching-repository";
import {
  classificationViews,
  saveCategoryInTransaction,
} from "./product-categories";
import { reviewCategoryWithLlm } from "./ai-gateway";
import { transaction } from "./database";
import { checkpoint } from "./task-context";
import { assertProductAvailable } from "./product-availability";
import { ProductGroupConflict } from "./store-product-groups";

export async function reviewCategory(
  task: TaskExecution,
  campaign: Campaign,
  product: StoreProduct,
): Promise<CategoryResult> {
  const view = (await classificationViews([product.id])).get(product.id)!;
  const base: CategoryResult = {
    source: "llm",
    name: product.name,
    retailer: product.retailer,
    source_category: product.category,
    search_name: product.normalized_name,
    assigned_category: null,
    suggested_category: null,
    probability: null,
    confidence: null,
    threshold: null,
    classification_id: view.classification_id,
    model: null,
    prompt_key: null,
    outcome: "skipped",
    reason: "Product no longer needs review",
  };
  if (view.state !== "uncertain") {
    // A restart after the category transaction must recover its saved result,
    // without paying again or replacing a later human correction.
    const own =
      view.source === "llm"
        ? await transaction(
            async (c) =>
              (
                await c.query(
                  "SELECT review_model,review_prompt_key,note FROM product_category_edits WHERE store_product_id=$1 AND review_task_id=$2 ORDER BY created_at DESC LIMIT 1",
                  [product.id, task.id],
                )
              ).rows[0],
          )
        : null;
    return own
      ? {
          ...base,
          outcome: "assigned",
          assigned_category: view.category,
          model: own.review_model,
          prompt_key: own.review_prompt_key,
          reason: own.note,
        }
      : base;
  }
  const answer = await reviewCategoryWithLlm(campaign, product);
  await checkpoint(true);
  const result: CategoryResult = {
    ...base,
    model: answer.model,
    prompt_key: answer.prompt_key,
    outcome: answer.category === "unknown" ? "uncertain" : "assigned",
    reason: answer.reason,
    assigned_category: answer.category === "unknown" ? null : answer.category,
  };
  if (answer.category === "unknown") return result;
  try {
    await transaction(async (c) => {
      await assertProductAvailable(product.id, task.options.source_id, c);
      await saveCategoryInTransaction(
        c,
        {
          id: product.group_id,
          member_id: product.id,
          snapshot: view.snapshot,
          action: "set",
          category: answer.category,
          note: `${answer.reason}\nSource: ${answer.quote}`,
        },
        answer.model,
        {
          source: "llm",
          task_id: task.id,
          model: answer.model,
          prompt_key: answer.prompt_key,
          generation_id: answer.generation_id,
        },
      );
    });
  } catch (error) {
    if (!(error instanceof ProductGroupConflict)) throw error;
    return {
      ...result,
      assigned_category: null,
      outcome: "skipped",
      reason: error.message,
    };
  }
  return result;
}
