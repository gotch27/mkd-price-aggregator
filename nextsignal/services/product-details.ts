import { matchingRules } from "./brand-catalog";
import { grantChangedProducts } from "./task-automation";
import { settings } from "@/nextsignal/config";
import { transaction } from "@/nextsignal/services/database";
import { logEvent } from "@/nextsignal/adapters/log-context";
import { hash } from "@/nextsignal/domain/normalize";
import {
  factNames,
  refreshProductFacts,
  type StoreProduct,
} from "@/nextsignal/domain/matching";
import {
  ProductEditValidation,
  validateDetailOverrides,
} from "@/nextsignal/domain/product-edit-validation";
import type {
  EditableProduct,
  ProductEditInput,
  ProductEditResult,
  ProductEditHistory,
  DetailChange,
} from "@/nextsignal/domain/product-edits";
import {
  readGroup,
  indexMember,
  knownConflict,
  ProductGroupConflict,
} from "@/nextsignal/services/store-product-groups";

export async function read(
  id: string,
  memberId: string,
): Promise<EditableProduct | null> {
  return transaction(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const group = await readGroup(c, id, true);
    const member = group?.members.find((p) => p.id === memberId);
    if (!group || !member || group.view.limited) return null;
    const history = member.indexed
      ? (
          await c.query<ProductEditHistory>(
            "SELECT id,actor,action,changes,note,created_at FROM product_detail_edits WHERE store_product_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2",
            [member.id, settings.product_details.history_limit],
          )
        ).rows
      : [];
    const total = member.indexed
      ? (
          await c.query<{ total: number }>(
            "SELECT count(*)::int AS total FROM product_detail_edits WHERE store_product_id=$1",
            [member.id],
          )
        ).rows[0].total
      : 0;
    return {
      id: group.view.id,
      member_id: member.id,
      snapshot: group.view.snapshot,
      retailer: member.retailer,
      name: member.name,
      facts: member.facts,
      overrides: member.manual_facts ?? {},
      history,
      history_total: total,
      limits: settings.product_details,
    };
  });
}

export async function save(
  input: ProductEditInput,
  actor: string,
): Promise<ProductEditResult> {
  const context = {
    actor,
    product_id: input.id,
    member_id: input.member_id,
    action: input.action,
  };
  try {
    const result = await transaction(async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtext('store-product-group-commit'))",
      );
      const group = await readGroup(c, input.id, true);
      if (!group || group.view.snapshot !== input.snapshot)
        throw new ProductGroupConflict(
          "Product details changed. Reload before saving your corrections.",
        );
      if (group.view.limited)
        throw new ProductGroupConflict(
          "This product group exceeds the editing limit. No changes were saved.",
        );
      const member = group.members.find((p) => p.id === input.member_id);
      if (!member)
        throw new ProductGroupConflict(
          "This store product is no longer in the group. Reload its details.",
        );
      const id = await indexMember(c, member);
      // Keep the group check consistent with provider fact refreshes as well as
      // manual/group commits. No network request is made under these locks.
      await c.query(
        "SELECT id FROM store_products WHERE group_id=$1 ORDER BY id FOR UPDATE",
        [group.view.id],
      );
      const current = (
        await c.query<StoreProduct>(
          "SELECT *,version::int FROM store_products WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (current.group_id !== group.view.id)
        throw new ProductGroupConflict(
          "The saved product connection changed. Reload before editing.",
        );
      if (member.indexed && current.version !== member.version)
        throw new ProductGroupConflict(
          "Product details changed while saving. Reload before editing again.",
        );
      const previous = current.manual_facts ?? {};
      const base = refreshProductFacts(
        { ...current, manual_facts: {} },
        await matchingRules(c, current.retailer),
        settings.matching.category_mappings,
      );
      const overrides =
        input.action === "reset"
          ? {}
          : validateDetailOverrides(
              { ...previous, ...input.changes },
              base.facts,
            );
      if (hash(previous) === hash(overrides))
        return {
          changed: false,
          product_id: group.view.id,
          store_product_id: id,
          retailer: current.retailer,
          changes: [] as DetailChange[],
          conflict: group.view.conflict,
        };
      const before = refreshProductFacts(
        current,
        await matchingRules(c, current.retailer),
        settings.matching.category_mappings,
      );
      const after = refreshProductFacts(
        { ...current, manual_facts: overrides },
        await matchingRules(c, current.retailer),
        settings.matching.category_mappings,
      );
      const changes = factNames
        .filter(
          (field) =>
            previous[field] !== overrides[field] ||
            before.facts[field]?.value !== after.facts[field]?.value,
        )
        .map((field) => ({
          field,
          before: before.facts[field]?.value ?? null,
          after: after.facts[field]?.value ?? null,
        }));
      await c.query(
        "INSERT INTO product_detail_edits(store_product_id,group_id,actor,action,changes,previous_overrides,overrides,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          group.view.id,
          actor,
          input.action,
          JSON.stringify(changes),
          JSON.stringify(previous),
          JSON.stringify(overrides),
          input.note,
        ],
      );
      await c.query(
        "UPDATE store_products SET category_pending=(manual_family IS NULL),rules_pending=true,ai_pending=true,manual_facts=$2,facts=$3,local_key=$4,version=version+1,updated_at=now() WHERE id=$1",
        [id, overrides, after.facts, after.local_key],
      );
      // Invalidate stale in-flight decisions and queue only this product. The
      // disabled worker/automatic flags still control all future provider work.
      await c.query(
        `INSERT INTO matching_work(store_product_id,reason) VALUES($1,'Product details corrected by a person')
        ON CONFLICT(store_product_id) DO UPDATE SET state='pending',campaign_id=NULL,token=NULL,lease_until=NULL,error=NULL,reason=excluded.reason,updated_at=now()`,
        [id],
      );
      await grantChangedProducts(c, [id], "manual_edit");
      const updated = await readGroup(c, group.view.id);
      if (!updated)
        throw new Error("Product group disappeared during detail update");
      const problem = knownConflict(updated.members);
      await c.query(
        "UPDATE products SET matching_conflict=$2,matching_version=matching_version+1 WHERE id=$1",
        [group.view.id, !!problem],
      );
      const connected =
        new Set(updated.members.map((p) => p.retailer)).size > 1;
      await c.query(
        `UPDATE store_products SET state=CASE WHEN $2 THEN 'legacy_conflict' WHEN $3 THEN 'matched' ELSE 'needs_info' END,
        last_reason=CASE WHEN $2 THEN 'Product details changed; saved connection needs review' WHEN $3 THEN 'Saved product connection preserved after detail edit' ELSE 'Product details corrected by a person' END
        WHERE group_id=$1 AND ($2 OR state='legacy_conflict' OR id=$4)`,
        [group.view.id, !!problem, connected, id],
      );
      return {
        changed: true,
        product_id: group.view.id,
        store_product_id: id,
        retailer: current.retailer,
        changes,
        conflict: !!problem,
      };
    });
    await logEvent(
      result.changed ? "info" : "debug",
      result.changed
        ? "products.details.updated"
        : "products.details.unchanged",
      result.changed
        ? "Product details updated by a person"
        : "Product details already match the submitted values",
      { ...context, ...result },
    );
    return { ok: true, changed: result.changed, product_id: result.product_id };
  } catch (error) {
    const expected =
      error instanceof ProductGroupConflict ||
      error instanceof ProductEditValidation;
    await logEvent(
      expected ? "warn" : "error",
      expected ? "products.details.rejected" : "products.details.failed",
      expected ? "Product detail edit rejected" : "Product detail edit failed",
      { ...context, ...(expected ? { reason: error.message } : {}) },
      expected ? undefined : error,
    );
    if (expected) return { ok: false, reason: error.message };
    throw error;
  }
}
