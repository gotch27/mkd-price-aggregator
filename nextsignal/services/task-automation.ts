import type { PoolClient } from "pg";
import {
  operationalSchema,
  type OperationEpochs,
} from "@/nextsignal/domain/task-settings";
import { taskContext } from "./task-context";
import { availableProductSql } from "./product-availability";

// Called inside the publication/edit transaction, never by a settings save or
// an indexing backfill. Only the changed products receive a future-work grant.
export async function grantChangedProducts(
  c: PoolClient,
  ids: string[],
  event: "import" | "manual_edit",
) {
  const context = taskContext();
  if (event === "import" && context?.task.kind !== "import") return;
  const saved = (
    await c.query(
      `SELECT policy,epochs FROM operational_settings WHERE id FOR SHARE`,
    )
  ).rows[0];
  if (!saved) return; // No operational settings means no automation permission.
  const live = operationalSchema.parse(saved.policy),
    epochs = saved.epochs as OperationEpochs;
  const captured = event === "import" ? context!.task.policy : live;
  const before = event === "import" ? context!.task.epochs : epochs;
  const ai = captured.ai_enabled && live.ai_enabled && before.ai === epochs.ai;
  const category =
    !live.paused &&
    ai &&
    captured.categorization === "automatic" &&
    live.categorization === "automatic" &&
    before.categorization === epochs.categorization;
  const match =
    !live.paused &&
    captured.matching === "automatic" &&
    live.matching === "automatic" &&
    before.matching === epochs.matching;
  await c.query(
    `INSERT INTO matching_work(store_product_id,reason,auto_category_epoch,auto_match_epoch,auto_ai_epoch)
    SELECT sp.id,$2,$3,$4,$5 FROM store_products sp WHERE sp.id=ANY($1::uuid[]) AND ${availableProductSql("sp")} ON CONFLICT(store_product_id) DO UPDATE SET auto_category_epoch=$3,auto_match_epoch=$4,auto_ai_epoch=$5`,
    [
      ids,
      event === "import"
        ? "New or changed product from an authorized import"
        : "Product details corrected by a person",
      category ? epochs.categorization : null,
      match ? epochs.matching : null,
      ai && !live.paused ? epochs.ai : null,
    ],
  );
}
