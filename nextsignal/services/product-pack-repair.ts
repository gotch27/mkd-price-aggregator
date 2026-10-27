import { settings } from "@/nextsignal/config";
import { hash } from "@/nextsignal/domain/normalize";
import { packCount } from "@/nextsignal/domain/pack-count";
import {
  refreshProductFacts,
  type StoreProduct,
} from "@/nextsignal/domain/matching";
import { transaction } from "@/nextsignal/services/database";
import { logEvent } from "@/nextsignal/adapters/log-context";

// Explicit bounded cache correction only. Never starts or authorizes matching,
// changes memberships/manual overrides, or makes a provider request.
export async function repairPackBatch(options: {
  phase: "store-products" | "listings";
  after: string | null;
  limit: number;
  apply: boolean;
}) {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 1000
  )
    throw new Error("Repair batch size must be between 1 and 1000 products");
  if (!["store-products", "listings"].includes(options.phase))
    throw new Error("Choose store-products or listings as the repair phase");
  const result = await transaction(async (c) => {
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtext('store-product-group-commit'))",
    );
    if (options.apply) {
      const state = (
        await c.query(
          "SELECT policy->>'paused' AS paused FROM operational_settings WHERE id=true FOR SHARE",
        )
      ).rows[0];
      if (state?.paused !== "true")
        throw new Error(
          "Pause all work before applying the product pack repair",
        );
    }
    const changes: { id: string; before_pack: unknown; after_pack: unknown }[] =
      [];
    if (options.phase === "store-products") {
      const rows = (
        await c.query<StoreProduct>(
          `SELECT sp.* FROM store_products sp
        WHERE sp.facts->'pack' IS NOT NULL AND sp.facts->'pack'<>'null'::jsonb
          AND NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id)
          AND ($1::uuid IS NULL OR sp.id>$1) ORDER BY sp.id LIMIT $2 FOR UPDATE OF sp`,
          [options.after, options.limit],
        )
      ).rows;
      for (const product of rows) {
        // A historical human fact without its override metadata must also be
        // retained rather than silently interpreted as a machine inference.
        if (
          product.facts.pack?.method === "manual" &&
          !("pack" in (product.manual_facts ?? {}))
        )
          continue;
        const refreshed = refreshProductFacts(
          product,
          settings.matching.local,
          settings.matching.category_mappings,
        );
        if (
          hash([product.facts, product.local_key]) ===
          hash([refreshed.facts, refreshed.local_key])
        )
          continue;
        changes.push({
          id: product.id,
          before_pack: product.facts.pack ?? null,
          after_pack: refreshed.facts.pack ?? null,
        });
        if (options.apply)
          await c.query(
            `UPDATE store_products SET facts=$2,local_key=$3,version=version+1,updated_at=now() WHERE id=$1`,
            [product.id, JSON.stringify(refreshed.facts), refreshed.local_key],
          );
      }
      return {
        examined: rows.length,
        changed: changes.length,
        cursor: rows.at(-1)?.id ?? options.after,
        completed: rows.length < options.limit,
        changes,
      };
    }
    const rows = (
      await c.query<{
        id: string;
        name: string;
        attributes: { pack: number | null };
      }>(
        `SELECT id,name,attributes FROM listings WHERE attributes->'pack' IS NOT NULL AND attributes->'pack'<>'null'::jsonb
        AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2 FOR UPDATE`,
        [options.after, options.limit],
      )
    ).rows;
    for (const listing of rows) {
      const next = packCount(listing.name)?.value ?? null;
      if (listing.attributes.pack === next) continue;
      changes.push({
        id: listing.id,
        before_pack: listing.attributes.pack,
        after_pack: next,
      });
      if (options.apply)
        await c.query(
          "UPDATE listings SET attributes=jsonb_set(attributes,'{pack}',$2::jsonb),updated_at=now() WHERE id=$1",
          [listing.id, JSON.stringify(next)],
        );
    }
    return {
      examined: rows.length,
      changed: changes.length,
      cursor: rows.at(-1)?.id ?? options.after,
      completed: rows.length < options.limit,
      changes,
    };
  });
  await logEvent(
    "info",
    "matching.pack_repair.batch",
    options.apply
      ? "Stored pack information corrected; manual details and connections preserved"
      : "Stored pack information repair dry run completed",
    { phase: options.phase, applied: options.apply, ...result },
  );
  return result;
}
