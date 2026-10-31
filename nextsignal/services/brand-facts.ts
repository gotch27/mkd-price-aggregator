import type { PoolClient } from "pg";
import { settings } from "@/nextsignal/config";
import { hash, normalizeName } from "@/nextsignal/domain/normalize";
import { prepareIdentity } from "@/nextsignal/domain/matching-identity";
import {
  localKey,
  type StoreProduct,
  type Fact,
} from "@/nextsignal/domain/matching";
import { readableProductText } from "@/nextsignal/domain/product-text";
import type { Brand } from "@/nextsignal/domain/brands";
import { transaction, withLock } from "./database";
import { readCatalog, rulesFromCatalog } from "./brand-catalog";
import { identityCatalog } from "./identity-catalog";
import { readSettings } from "./task-settings";
import { logEvent } from "@/nextsignal/adapters/log-context";

export async function queueBrandRefresh(
  c: PoolClient,
  after: Brand,
  before: Brand | null,
) {
  const signature = (b: Brand | null) =>
    b?.aliases.map((a) => [normalizeName(a.name), a.retailer]).sort();
  if (
    before?.active === after.active &&
    hash(signature(before)) === hash(signature(after))
  )
    return null;
  const pattern = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;
  const aliases = [...(before?.aliases ?? []), ...after.aliases].map((a) => ({
    pattern: pattern(normalizeName(a.name)),
    raw_pattern: pattern(a.name),
    retailer: a.retailer,
  }));
  const key = hash([after.id, after.revision, "brand-facts"]);
  return (
    await c.query<{ id: string }>(
      "INSERT INTO brand_fact_refresh(request_key,brand_id,aliases) VALUES($1,$2,$3) ON CONFLICT(request_key) DO UPDATE SET request_key=excluded.request_key RETURNING id",
      [key, after.id, JSON.stringify(aliases)],
    )
  ).rows[0].id;
}
export async function refreshSafely() {
  try {
    await refreshBatch();
  } catch (error) {
    await logEvent(
      "warn",
      "brands.refresh.waiting",
      "Brand saved; local product facts will refresh when the worker is available",
      {},
      error,
    );
  }
}
export async function refreshBatch() {
  if ((await readSettings()).policy.paused) return;
  return withLock("brand-fact-refresh", async () => {
    const result = await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('brand-catalog'))");
      const job = (
        await c.query<{
          id: string;
          brand_id: string | null;
          aliases: {
            pattern: string;
            raw_pattern: string;
            retailer: string | null;
          }[];
          product_ids: string[];
          cursor: string | null;
          undo_requested: boolean;
          updated_products: number;
        }>(
          "SELECT * FROM brand_fact_refresh WHERE state IN('pending','running','undo_pending') ORDER BY undo_requested DESC,CASE WHEN undo_requested THEN sequence END DESC,sequence LIMIT 1 FOR UPDATE SKIP LOCKED",
        )
      ).rows[0];
      if (!job) return null;
      const catalog = await readCatalog(c);
      const limit = settings.brand_review.refresh_batch_size;
      if (job.undo_requested) {
        const rows = (
          await c.query<{
            store_product_id: string;
            fingerprint: string;
            before_fact: Fact | null;
            after_fact: Fact | null;
          }>(
            "SELECT * FROM brand_fact_changes WHERE job_id=$1 AND NOT restored ORDER BY store_product_id LIMIT $2 FOR UPDATE",
            [job.id, limit],
          )
        ).rows;
        let restored = 0;
        for (const row of rows) {
          const p = (
            await c.query<StoreProduct>(
              "SELECT *,version::int version FROM store_products WHERE id=$1 FOR UPDATE",
              [row.store_product_id],
            )
          ).rows[0];
          if (
            p &&
            p.fingerprint === row.fingerprint &&
            !Object.hasOwn(p.manual_facts ?? {}, "brand") &&
            hash(p.facts.brand ?? null) === hash(row.after_fact)
          ) {
            const facts = { ...p.facts };
            if (row.before_fact) facts.brand = row.before_fact;
            else delete facts.brand;
            const rules = rulesFromCatalog(catalog, p.retailer);
            await c.query(
              "UPDATE store_products SET facts=$2,local_key=$3,version=version+1,updated_at=now() WHERE id=$1",
              [
                p.id,
                facts,
                localKey(
                  readableProductText(p.name, p.retailer),
                  facts,
                  p.ambiguous,
                  rules,
                ),
              ],
            );
            restored++;
          }
          await c.query(
            "UPDATE brand_fact_changes SET restored=true WHERE job_id=$1 AND store_product_id=$2",
            [job.id, row.store_product_id],
          );
        }
        await c.query(
          "UPDATE brand_fact_refresh SET state=$2,updated_at=now() WHERE id=$1",
          [job.id, rows.length < limit ? "undone" : "undo_pending"],
        );
        return {
          job_id: job.id,
          complete: rows.length < limit,
          restored,
          updated: 0,
        };
      }
      const rows = (
        await c.query<StoreProduct & { brand_id: string | null }>(
          `SELECT sp.*,sp.version::int AS version FROM store_products sp WHERE ($1::uuid IS NULL OR sp.id>$1) AND (sp.brand_id=$2 OR sp.id=ANY($5::uuid[]) OR EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) a(pattern text,raw_pattern text,retailer text) WHERE (a.retailer IS NULL OR a.retailer=sp.retailer) AND (sp.normalized_name ILIKE a.pattern OR sp.name ILIKE a.raw_pattern OR sp.description ILIKE a.raw_pattern))) ORDER BY sp.id LIMIT $4 FOR UPDATE`,
          [
            job.cursor,
            job.brand_id,
            JSON.stringify(job.aliases),
            limit,
            job.product_ids,
          ],
        )
      ).rows;
      let updated = 0;
      for (const p of rows) {
        if (Object.hasOwn(p.manual_facts ?? {}, "brand")) continue;
        const rules = rulesFromCatalog(catalog, p.retailer);
        const prepared = prepareIdentity(
          p,
          rules,
          settings.matching.category_mappings,
          identityCatalog,
        );
        const facts = { ...p.facts };
        if (prepared.facts.brand) facts.brand = prepared.facts.brand;
        else delete facts.brand;
        const expectedId = prepared.facts.brand?.value
          ? ((
              await c.query("SELECT id FROM brands WHERE active AND slug=$1", [
                prepared.facts.brand.value,
              ])
            ).rows[0]?.id ?? null)
          : null;
        const meaning = (f: Fact | undefined) =>
          f ? [f.value, f.source, f.quote, f.method] : null;
        if (
          hash(meaning(facts.brand)) === hash(meaning(p.facts.brand)) &&
          p.brand_id === expectedId
        )
          continue;
        await c.query(
          "INSERT INTO brand_fact_changes(job_id,store_product_id,fingerprint,before_fact,after_fact) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [
            job.id,
            p.id,
            p.fingerprint,
            p.facts.brand ?? null,
            facts.brand ?? null,
          ],
        );
        await c.query(
          "UPDATE store_products SET facts=$2,local_key=$3,version=version+1,updated_at=now() WHERE id=$1",
          [
            p.id,
            facts,
            localKey(
              readableProductText(p.name, p.retailer),
              facts,
              p.ambiguous,
              rules,
            ),
          ],
        );
        updated++;
      }
      await c.query(
        "UPDATE brand_fact_refresh SET state=$2,cursor=$3,updated_products=updated_products+$4,updated_at=now() WHERE id=$1",
        [
          job.id,
          rows.length < limit ? "completed" : "running",
          rows.at(-1)?.id ?? job.cursor,
          updated,
        ],
      );
      return {
        job_id: job.id,
        complete: rows.length < limit,
        updated,
        restored: 0,
      };
    });
    if (result)
      await logEvent(
        result.complete ? "info" : "debug",
        result.restored ? "brands.facts.restored" : "brands.facts.refreshed",
        result.restored
          ? "Product brand facts restored; newer corrections preserved"
          : "Affected product brand facts refreshed locally",
        result,
      );
    return result;
  });
}
