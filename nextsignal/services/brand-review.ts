import { settings } from "@/nextsignal/config";
import { hash, normalizeName } from "@/nextsignal/domain/normalize";
import { readableProductText } from "@/nextsignal/domain/product-text";
import { BrandConflict, type Brand } from "@/nextsignal/domain/brands";
import {
  BrandReviewConflict,
  type BrandReviewStart,
  type BrandReviewSession,
  type BrandReviewItem,
  type BrandReviewContext,
  type BrandReviewSubmission,
} from "@/nextsignal/domain/brand-review";
import type { PoolClient } from "pg";
import { pool, transaction } from "./database";
import { matchingPrompts } from "./matching-prompts";
import { reviewCandidates } from "./brand-review-candidates";
import { readBrand, saveInTransaction } from "./brands";
import { refreshSafely } from "./brand-facts";
import { availableProductSql } from "./product-availability";
import { logEvent } from "@/nextsignal/adapters/log-context";

async function owned(
  c: Pick<PoolClient, "query">,
  id: string,
  actor: string,
  lock = false,
) {
  const row = (
    await c.query<{
      id: string;
      state: BrandReviewSession["state"];
      options: BrandReviewStart;
      acknowledged_at: string | null;
      request_key: string;
    }>(
      `SELECT * FROM brand_review_sessions WHERE id=$1 AND actor=$2${lock ? " FOR UPDATE" : ""}`,
      [id, actor],
    )
  ).rows[0];
  if (!row) throw new BrandReviewConflict("Brand review session not found");
  return row;
}
export async function readSession(
  id: string,
  actor: string,
  c: Pick<PoolClient, "query"> = pool,
): Promise<BrandReviewSession> {
  const row = await owned(c, id, actor);
  const results = (
    await c.query<BrandReviewItem>(
      "SELECT i.id,i.position,i.input_key,i.term,i.examples,i.affected,i.state,i.reason,i.brand_id,b.name AS brand_name,i.undo_status FROM brand_review_items i LEFT JOIN brands b ON b.id=i.brand_id WHERE i.session_id=$1 ORDER BY i.position",
      [id],
    )
  ).rows;
  const last = (
    await c.query(
      "SELECT b.undone_at,EXISTS(SELECT 1 FROM brand_review_items i WHERE i.batch_id=b.id AND i.state='saved') saved FROM brand_review_batches b WHERE b.session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
      [id],
    )
  ).rows[0];
  return {
    id: row.id,
    state: row.state,
    options: row.options,
    acknowledged_at: row.acknowledged_at,
    total: results.length,
    processed: results.filter((r) => r.state !== "pending").length,
    saved: results.filter(
      (r) => r.state === "saved" && r.undo_status !== "restored",
    ).length,
    skipped: results.filter((r) => r.state === "skipped").length,
    rejected: results.filter((r) => r.state === "rejected").length,
    can_undo: !!last?.saved && !last.undone_at,
    results,
  };
}
export async function readContext(actor: string): Promise<BrandReviewContext> {
  const last = (
    await pool.query(
      "SELECT id FROM brand_review_sessions WHERE actor=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
      [actor],
    )
  ).rows[0];
  return {
    limits: {
      default_groups: settings.brand_review.default_groups,
      default_include_previously_skipped:
        settings.brand_review.default_include_previously_skipped,
      max_groups: settings.brand_review.max_groups,
      batch_size: settings.brand_review.batch_size,
      examples_per_group: settings.brand_review.examples_per_group,
      scan_products: settings.brand_review.scan_products,
      refresh_ms: settings.brand_review.refresh_ms,
      results_page_size: settings.brand_review.results_page_size,
    },
    instructions: matchingPrompts.brandReview,
    session: last ? await readSession(last.id, actor) : null,
    refresh_pending: (
      await pool.query(
        "SELECT count(*)::int count FROM brand_fact_refresh WHERE state IN('pending','running','undo_pending')",
      )
    ).rows[0].count,
  };
}
export async function startSession(input: BrandReviewStart, actor: string) {
  if (input.limit < 1 || input.limit > settings.brand_review.max_groups)
    throw new BrandReviewConflict(
      "Choose a bounded number of brand spelling groups",
    );
  const id = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `brand-review:${actor}`,
    ]);
    const prior = (
      await c.query(
        "SELECT id,request_key FROM brand_review_sessions WHERE actor=$1 AND request_id=$2",
        [actor, input.request_id],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_key !== hash(input))
        throw new BrandReviewConflict(
          "Request ID was already used with different settings",
        );
      return prior.id as string;
    }
    if (
      (
        await c.query(
          "SELECT 1 FROM brand_review_sessions WHERE actor=$1 AND state='active'",
          [actor],
        )
      ).rowCount
    )
      throw new BrandReviewConflict(
        "Read or stop the active brand review before starting another",
      );
    const candidates = await reviewCandidates(c, input);
    const selected = [];
    for (const candidate of candidates) {
      if (selected.length >= input.limit) break;
      if (
        !input.include_previously_skipped &&
        (
          await c.query(
            "SELECT 1 FROM brand_review_items WHERE input_key=$1 AND state='skipped'",
            [candidate.input_key],
          )
        ).rowCount
      )
        continue;
      selected.push(candidate);
    }
    const session = (
      await c.query(
        "INSERT INTO brand_review_sessions(actor,request_id,request_key,agent_name,agent_model,state,options) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [
          actor,
          input.request_id,
          hash(input),
          input.agent_name,
          input.agent_model,
          selected.length ? "active" : "completed",
          input,
        ],
      )
    ).rows[0].id;
    for (const [position, item] of selected.entries())
      await c.query(
        "INSERT INTO brand_review_items(session_id,position,input_key,term,examples,affected) VALUES($1,$2,$3,$4,$5,$6)",
        [
          session,
          position,
          item.input_key,
          item.term,
          JSON.stringify(item.examples),
          item.affected,
        ],
      );
    return session as string;
  });
  const session = await readSession(id, actor);
  await logEvent(
    "info",
    "brands.review.started",
    "Brand spelling review started",
    {
      session_id: id,
      actor,
      reviewer: input.reviewer,
      groups: session.total,
      scan_limit: settings.brand_review.scan_products,
    },
  );
  return session;
}
export async function readBatch(id: string, actor: string) {
  const session = await readSession(id, actor);
  return {
    session_id: id,
    state: session.state,
    groups: session.results
      .filter((r) => r.state === "pending")
      .slice(0, settings.brand_review.batch_size),
  };
}
export async function submitBatch(input: BrandReviewSubmission, actor: string) {
  if (
    !input.decisions.length ||
    input.decisions.length > settings.brand_review.batch_size ||
    new Set(input.decisions.map((d) => d.item_id)).size !==
      input.decisions.length
  )
    throw new BrandReviewConflict(
      "Submit a bounded batch with each group once",
    );
  const session = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('brand-catalog'))");
    const session = await owned(c, input.id, actor, true);
    if (session.options.reviewer !== input.reviewer)
      throw new BrandReviewConflict(
        "Use a review session with the correct Human or Agent source",
      );
    const prior = (
      await c.query(
        "SELECT request_key,result FROM brand_review_batches WHERE session_id=$1 AND request_id=$2",
        [input.id, input.request_id],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_key !== hash(input.decisions))
        throw new BrandReviewConflict(
          "Batch request ID was used for different decisions",
        );
      return prior.result as BrandReviewSession;
    }
    if (session.state !== "active")
      throw new BrandReviewConflict("This brand review is not active");
    const batch = (
      await c.query(
        "INSERT INTO brand_review_batches(session_id,request_id,request_key,result) VALUES($1,$2,$3,'{}') RETURNING id",
        [input.id, input.request_id, hash(input.decisions)],
      )
    ).rows[0].id;
    const revisions = new Map<string, { reviewed: number; current: number }>();
    const newBrands = new Map<string, string>();
    for (const decision of input.decisions) {
      const item = (
        await c.query<BrandReviewItem>(
          "SELECT * FROM brand_review_items WHERE session_id=$1 AND id=$2 FOR UPDATE",
          [input.id, decision.item_id],
        )
      ).rows[0];
      if (
        !item ||
        item.state !== "pending" ||
        item.input_key !== decision.snapshot
      )
        throw new BrandReviewConflict(
          "Use the exact pending group snapshot returned by this session",
        );
      await c.query("SAVEPOINT brand_item");
      try {
        for (const example of item.examples) {
          const live = (
            await c.query(
              `SELECT sp.fingerprint,sp.manual_facts FROM store_products sp WHERE sp.id=$1 AND ${availableProductSql("sp")} FOR SHARE`,
              [example.id],
            )
          ).rows[0];
          if (
            !live ||
            live.fingerprint !== example.fingerprint ||
            Object.hasOwn(live.manual_facts ?? {}, "brand")
          )
            throw new BrandReviewConflict(
              "Source information or a human brand correction changed; review the current product",
            );
        }
        if (decision.action === "skip") {
          for (const example of item.examples)
            await c.query(
              "INSERT INTO brand_review_skips(store_product_id,fingerprint) VALUES($1,$2) ON CONFLICT DO NOTHING",
              [example.id, example.fingerprint],
            );
          await c.query(
            "UPDATE brand_review_items SET state='skipped',reason=$3,batch_id=$4 WHERE session_id=$1 AND id=$2",
            [input.id, item.id, decision.reason, batch],
          );
        } else {
          for (const alias of decision.aliases) {
            const term = normalizeName(alias.name);
            if (
              !/[a-z]/.test(term) ||
              matchingPrompts.brandLanguage.stop_words.includes(term)
            )
              throw new BrandReviewConflict(
                "A generic product word cannot establish a brand alias",
              );
            const stores = new Set<string>();
            for (const proof of alias.evidence) {
              const example = item.examples.find(
                (e) => e.id === proof.member_id,
              );
              if (
                !example ||
                !example[proof.field]?.includes(proof.quote) ||
                normalizeName(
                  readableProductText(proof.quote, example.retailer),
                ) !== term ||
                (alias.retailer !== null && alias.retailer !== example.retailer)
              )
                throw new BrandReviewConflict(
                  "Alias evidence must copy the exact original source spelling in this group's examples",
                );
              stores.add(example.retailer);
            }
            if (!stores.size || (alias.retailer === null && stores.size < 2))
              throw new BrandReviewConflict(
                "A global alias needs matching evidence from two stores; use a store-specific alias otherwise",
              );
          }
          const target =
            decision.brand_id ?? newBrands.get(normalizeName(decision.name!));
          const before = target ? await readBrand(c, target) : null;
          if (decision.brand_id && !before)
            throw new BrandReviewConflict("Brand not found");
          if (decision.brand_id && before) {
            const revision = revisions.get(before.id);
            if (
              decision.brand_revision !== before.revision &&
              decision.brand_revision !== revision?.reviewed
            )
              throw new BrandReviewConflict(
                "This brand changed. Reload before saving.",
              );
          }
          const after = await saveInTransaction(
            c,
            {
              name: before?.name ?? decision.name!,
              aliases: [
                ...(before?.aliases ?? []).map((a) => ({
                  name: a.name,
                  retailer: a.retailer,
                })),
                ...decision.aliases.map((a) => ({
                  name: a.name,
                  retailer: a.retailer,
                })),
              ],
            },
            actor,
            before?.id,
            before?.revision,
            {
              source: session.options.reviewer,
              reason: decision.reason,
              session_id: input.id,
              canonical_aliases: false,
            },
          );
          if (before)
            revisions.set(after.id, {
              reviewed: revisions.get(after.id)?.reviewed ?? before.revision,
              current: after.revision,
            });
          else newBrands.set(normalizeName(decision.name!), after.id);
          const job = (
            await c.query(
              "SELECT id FROM brand_fact_refresh WHERE request_key=$1",
              [hash([after.id, after.revision, "brand-facts"])],
            )
          ).rows[0];
          if (job) {
            const aliases = decision.aliases.flatMap((alias) =>
              alias.evidence.map((proof) => ({
                pattern: `%${normalizeName(alias.name).replace(/[\\%_]/g, "\\$&")}%`,
                raw_pattern: `%${proof.quote.replace(/[\\%_]/g, "\\$&")}%`,
                retailer: alias.retailer,
              })),
            );
            await c.query(
              "UPDATE brand_fact_refresh SET product_ids=$2,aliases=aliases||$3::jsonb WHERE id=$1",
              [
                job.id,
                [
                  ...new Set(
                    decision.aliases.flatMap((a) =>
                      a.evidence.map((e) => e.member_id),
                    ),
                  ),
                ],
                JSON.stringify(aliases),
              ],
            );
          }
          await c.query(
            "UPDATE brand_review_items SET state='saved',reason=$3,brand_id=$4,before_record=$5,after_record=$6,batch_id=$7,refresh_job_id=$8 WHERE session_id=$1 AND id=$2",
            [
              input.id,
              item.id,
              decision.reason,
              after.id,
              before,
              after,
              batch,
              job?.id ?? null,
            ],
          );
        }
        await c.query("RELEASE SAVEPOINT brand_item");
      } catch (error) {
        await c.query("ROLLBACK TO SAVEPOINT brand_item");
        await c.query("RELEASE SAVEPOINT brand_item");
        if (
          !(error instanceof BrandReviewConflict) &&
          !(error instanceof BrandConflict)
        )
          throw error;
        await c.query(
          "UPDATE brand_review_items SET state='rejected',reason=$3,batch_id=$4 WHERE session_id=$1 AND id=$2",
          [input.id, item.id, error.message, batch],
        );
      }
    }
    await c.query(
      "UPDATE brand_review_sessions SET state=CASE WHEN EXISTS(SELECT 1 FROM brand_review_items WHERE session_id=$1 AND state='pending') THEN 'active' ELSE 'completed' END,updated_at=now() WHERE id=$1",
      [input.id],
    );
    const result = await readSession(input.id, actor, c);
    await c.query("UPDATE brand_review_batches SET result=$2 WHERE id=$1", [
      batch,
      result,
    ]);
    return result;
  });
  await logEvent("info", "brands.review.batch", "Brand review batch saved", {
    session_id: input.id,
    actor,
    groups: input.decisions.length,
    saved: session.saved,
    skipped: session.skipped,
    rejected: session.rejected,
  });
  await refreshSafely();
  return session;
}
export async function control(
  id: string,
  actor: string,
  action: "stop" | "acknowledge" | "undo",
  reviewer?: "human" | "agent",
) {
  if (action === "undo" && !reviewer)
    throw new BrandReviewConflict(
      "Record whether Human or Agent requested undo",
    );
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('brand-catalog'))");
    await owned(c, id, actor, true);
    if (action === "stop") {
      await c.query(
        "UPDATE brand_review_sessions SET state='stopped',updated_at=now() WHERE id=$1 AND state='active'",
        [id],
      );
      return;
    }
    if (action === "acknowledge") {
      await c.query(
        "UPDATE brand_review_sessions SET acknowledged_at=now() WHERE id=$1 AND state<>'active'",
        [id],
      );
      return;
    }
    const batch = (
      await c.query(
        "SELECT * FROM brand_review_batches WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!batch || batch.undone_at)
      throw new BrandReviewConflict("There is no saved batch to undo");
    const items = (
      await c.query<
        BrandReviewItem & {
          before_record: Brand | null;
          after_record: Brand;
          refresh_job_id: string | null;
        }
      >(
        "SELECT * FROM brand_review_items WHERE batch_id=$1 AND state='saved' ORDER BY position",
        [batch.id],
      )
    ).rows;
    const grouped = new Map<string, typeof items>();
    for (const item of items) {
      const rows = grouped.get(item.brand_id!) ?? [];
      rows.push(item);
      grouped.set(item.brand_id!, rows);
    }
    for (const [brandId, rows] of grouped) {
      rows.sort((a, b) => a.after_record.revision - b.after_record.revision);
      const current = await readBrand(c, brandId),
        last = rows.at(-1)!,
        before = rows[0].before_record;
      if (!current || current.revision !== last.after_record.revision) {
        for (const row of rows)
          await c.query(
            "UPDATE brand_review_items SET undo_status='changed' WHERE session_id=$1 AND id=$2",
            [id, row.id],
          );
        continue;
      }
      await c.query(
        "UPDATE brands SET name=$2,active=$3,revision=revision+1,updated_at=now() WHERE id=$1",
        [brandId, before?.name ?? current.name, before?.active ?? false],
      );
      await c.query("DELETE FROM brand_aliases WHERE brand_id=$1", [brandId]);
      for (const alias of before?.aliases ?? [])
        await c.query(
          "INSERT INTO brand_aliases(id,brand_id,name,normalized_name,retailer) VALUES($1,$2,$3,$4,$5)",
          [
            alias.id,
            brandId,
            alias.name,
            normalizeName(alias.name),
            alias.retailer,
          ],
        );
      const restored = await readBrand(c, brandId);
      await c.query(
        "INSERT INTO brand_edits(brand_id,actor,before_record,after_record,source,reason,session_id) VALUES($1,$2,$3,$4,$5,'Undo brand review batch',$6)",
        [brandId, actor, current, restored, reviewer, id],
      );
      for (const row of [...rows].reverse()) {
        if (row.refresh_job_id)
          await c.query(
            "UPDATE brand_fact_refresh SET undo_requested=true,state='undo_pending',updated_at=now() WHERE id=$1",
            [row.refresh_job_id],
          );
        await c.query(
          "UPDATE brand_review_items SET undo_status='restored' WHERE session_id=$1 AND id=$2",
          [id, row.id],
        );
      }
    }
    await c.query(
      "UPDATE brand_review_batches SET undone_at=now() WHERE id=$1",
      [batch.id],
    );
  });
  await logEvent(
    "info",
    `brands.review.${action}`,
    `Brand review ${action} recorded`,
    { session_id: id, actor },
  );
  if (action === "undo") await refreshSafely();
  return readSession(id, actor);
}
