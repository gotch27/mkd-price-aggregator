import { matchingRules } from "./brand-catalog";
import { settings } from "@/nextsignal/config";
import { pool, transaction } from "@/nextsignal/services/database";
import {
  manualLinks,
  pairKey,
} from "@/nextsignal/services/manual-match-memory";
import { hash, normalizeName } from "@/nextsignal/domain/normalize";
import { wholeNameSearchPatterns } from "@/nextsignal/domain/local-matching";
import type {
  ManualCommand,
  ManualGroup,
  ManualResult,
  ManualSearch,
} from "@/nextsignal/domain/manual-matching";
import { logEvent } from "@/nextsignal/adapters/log-context";

import {
  readGroup,
  indexMember,
  knownConflict,
  ProductGroupConflict as Conflict,
  type Group,
} from "@/nextsignal/services/store-product-groups";
const limits = settings.matching.manual;

export async function search(
  id: string,
  search: string,
  page: number,
  retailer?: string,
): Promise<ManualSearch> {
  const result = await transaction(async (c) => {
    // Keep the count, selected page and group snapshots consistent while other
    // users save connections. No model calls or writes happen during search.
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const group = await readGroup(c, id);
    const empty = {
      group: group?.view ?? null,
      candidates: [],
      limits,
      page: 1,
      page_size: limits.candidate_limit,
      total: 0,
      total_pages: 0,
    };
    if (!group || normalizeName(search).length < limits.search_min_length)
      return empty;
    const terms = wholeNameSearchPatterns(search, await matchingRules());
    const result = await c.query<{
      total: number;
      page: number;
      product_id: string | null;
    }>(
      `WITH found AS MATERIALIZED (
        SELECT b.product_id,min(b.name) AS name FROM store_product_identity_browser b
        WHERE b.product_id<>$1 AND b.normalized_name ~ ANY($2::text[]) AND ($3::text IS NULL OR b.retailer=$3)
        GROUP BY b.product_id
      ), eligible AS MATERIALIZED (
        SELECT f.* FROM found f WHERE NOT EXISTS(
          SELECT 1 FROM store_product_identity_browser member WHERE member.product_id=f.product_id AND member.retailer=ANY($4::text[])
        )
      ), totals AS (
        SELECT count(*)::int AS total FROM eligible
      ), paging AS (
        SELECT total,LEAST($6::numeric,GREATEST(ceil(total::numeric/$5),1))::int AS page FROM totals
      ), selected AS (
        SELECT * FROM eligible ORDER BY name,product_id LIMIT $5 OFFSET (SELECT (page-1)::bigint*$5 FROM paging)
      ) SELECT paging.*,selected.product_id FROM paging LEFT JOIN selected ON true ORDER BY selected.name,selected.product_id`,
      [
        group.view.id,
        terms,
        retailer ?? null,
        group.members.map((p) => p.retailer),
        limits.candidate_limit,
        page,
      ],
    );
    const candidates: ManualGroup[] = [];
    for (const row of result.rows) {
      if (!row.product_id) continue;
      const candidate = await readGroup(c, row.product_id);
      if (candidate) candidates.push(candidate.view);
    }
    const total = result.rows[0].total;
    return {
      group: group.view,
      candidates,
      limits,
      page: result.rows[0].page,
      page_size: limits.candidate_limit,
      total,
      total_pages: Math.ceil(total / limits.candidate_limit),
    };
  });
  await logEvent(
    "debug",
    "matching.manual.searched",
    "Manual counterpart search completed",
    {
      group_id: result.group?.id ?? id,
      result_count: result.candidates.length,
      retailer: retailer ?? null,
      page: result.page,
      page_size: result.page_size,
      total: result.total,
    },
  );
  return result;
}

// Index just the selected identities and their branch copies, never the entire
// catalog. Legacy browsing therefore works before the large migration backfill.
function checkGroup(
  group: Group | null,
  snapshot: string | undefined,
): asserts group is Group {
  if (!group) throw new Conflict("This product no longer exists.");
  if (group.view.snapshot !== snapshot)
    throw new Conflict(
      "The product group changed. Reload and review the current products.",
    );
  if (group.view.limited)
    throw new Conflict(
      "This product group exceeds the manual editing limit. No changes were saved.",
    );
  if (!group.members.length)
    throw new Conflict(
      "There are no saved store products in this group to connect.",
    );
}
export async function save(
  input: ManualCommand,
  actor: string,
): Promise<ManualResult> {
  await logEvent(
    "info",
    "matching.manual.requested",
    "Manual product change requested",
    {
      group_id: input.id,
      action: input.action,
      actor,
      candidate_id: input.candidate_id,
      member_id: input.member_id,
    },
  );
  try {
    const productId = await transaction(async (c) => {
      await c.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtext('store-product-group-commit'))",
      );
      const group = await readGroup(c, input.id);
      checkGroup(group, input.snapshot);
      const candidate =
        input.action === "connect" && input.candidate_id
          ? await readGroup(c, input.candidate_id)
          : null;
      if (input.action === "connect") {
        checkGroup(candidate, input.candidate_snapshot);
        if (group.view.id === candidate.view.id)
          throw new Conflict("These products are already connected.");
        const conflict = knownConflict([
          ...group.members,
          ...candidate.members,
        ]);
        if (conflict) throw new Conflict(conflict);
      } else if (
        group.members.length < 2 ||
        !group.members.some((p) => p.id === input.member_id)
      )
        throw new Conflict("Choose a connected store product to separate.");
      const before = [group, ...(candidate ? [candidate] : [])];
      const mapping = new Map<string, string>();
      for (const g of before)
        for (const p of g.members) mapping.set(p.id, await indexMember(c, p));
      const indexed = (
        await c.query<{
          id: string;
          group_id: string;
          branch_conflict: boolean;
        }>(
          "SELECT id,group_id,branch_conflict FROM store_products WHERE id=ANY($1::uuid[])",
          [[...mapping.values()]],
        )
      ).rows;
      for (const g of before)
        for (const p of g.members) {
          const current = indexed.find((row) => row.id === mapping.get(p.id));
          if (
            !current ||
            current.group_id !== g.view.id ||
            current.branch_conflict
          )
            throw new Conflict(
              "Branch records point to another saved connection. Finish indexing this product before changing its group.",
            );
        }
      // Lock products in the same order as the automatic group commit. No model
      // call or broad reset takes place inside this transaction.
      const groupIds = before.map((g) => g.view.id).sort();
      await c.query(
        "SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [groupIds],
      );
      const ids = [...mapping.values()];
      await c.query(
        "SELECT id FROM store_products WHERE group_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [groupIds],
      );
      const prior = await manualLinks(c, ids);
      let target = group.view.id;
      const action = input.action === "connect" ? "same" : "different";
      const reason =
        input.action === "connect"
          ? "Manually confirmed as the same product"
          : "Manually separated; keep these products apart";
      const anchor = mapping.get(group.members[0].id)!;
      const decision = (
        await c.query<{ id: string }>(
          `INSERT INTO store_match_decisions(store_product_id,candidate_id,group_id,outcome,reason,input_key,source_version,evidence,prompt_version)
        SELECT id,$2,$3,$4,$5,$6,version,$7,'manual-v1' FROM store_products WHERE id=$1 RETURNING id`,
          [
            anchor,
            candidate
              ? mapping.get(candidate.members[0].id)
              : mapping.get(input.member_id!),
            input.action === "connect" ? target : null,
            input.action === "connect" ? "manual_match" : "manual_separate",
            reason,
            hash(input),
            {
              actor,
              note: input.note,
              groups: before.map((g) => g.view),
              previous_manual_decisions: [...prior],
            },
          ],
        )
      ).rows[0].id;
      const pairs: [string, string][] = [];
      if (candidate) {
        for (const a of group.members)
          for (const b of candidate.members)
            pairs.push([mapping.get(a.id)!, mapping.get(b.id)!]);
        await c.query(
          `INSERT INTO product_membership_history(store_product_id,from_group_id,to_group_id,decision_id)
          SELECT id,group_id,$2,$3 FROM store_products WHERE group_id=$1`,
          [candidate.view.id, target, decision],
        );
        await c.query(
          `UPDATE store_products SET group_id=$2,version=version+1,state='matched',last_reason=$3,updated_at=now() WHERE group_id=ANY($1::uuid[])`,
          [groupIds, target, reason],
        );
        await c.query("UPDATE products SET redirect_id=$2 WHERE id=$1", [
          candidate.view.id,
          target,
        ]);
      } else {
        const removed = mapping.get(input.member_id!)!;
        for (const p of group.members)
          if (mapping.get(p.id) !== removed)
            pairs.push([removed, mapping.get(p.id)!]);
        target = (
          await c.query<{ id: string }>(
            `INSERT INTO products(name,normalized_name,attributes)
          SELECT name,normalized_name,(SELECT coalesce(jsonb_object_agg(key,value->'value'),'{}') FROM jsonb_each(facts)) FROM store_products WHERE id=$1 RETURNING id`,
            [removed],
          )
        ).rows[0].id;
        await c.query(
          "INSERT INTO product_membership_history(store_product_id,from_group_id,to_group_id,decision_id) VALUES($1,$2,$3,$4)",
          [removed, group.view.id, target, decision],
        );
        await c.query(
          "UPDATE store_products SET group_id=$2,version=version+1,state='needs_info',last_reason=$3,updated_at=now() WHERE id=$1",
          [removed, target, reason],
        );
      }
      for (const pair of pairs) {
        const [a, b] = pair.sort();
        await c.query(
          "INSERT INTO manual_product_links(a_id,b_id,action,actor,note,decision_id) VALUES($1,$2,$3,$4,$5,$6)",
          [a, b, action, actor, input.note, decision],
        );
      }
      await c.query(
        "UPDATE products SET matching_version=matching_version+1 WHERE id=ANY($1::uuid[])",
        [[...groupIds, target]],
      );
      await c.query(
        "UPDATE store_match_decisions SET source_version=(SELECT version FROM store_products WHERE id=$2) WHERE id=$1",
        [decision, anchor],
      );
      // In-flight answers lose their claim and revision. Completed decisions
      // stay in history; a later new counterpart may still grow this group.
      await c.query(
        "UPDATE matching_work SET state='completed',token=NULL,lease_until=NULL,reason=$2,updated_at=now() WHERE store_product_id=ANY($1::uuid[])",
        [ids, reason],
      );
      for (const g of [group.view.id, target]) {
        const current = await readGroup(c, g);
        const problem = current ? knownConflict(current.members) : null;
        await c.query("UPDATE products SET matching_conflict=$2 WHERE id=$1", [
          g,
          !!problem,
        ]);
        if (!problem && current)
          await c.query(
            "UPDATE store_products SET state=$2,last_reason=$3 WHERE group_id=$1 AND state='legacy_conflict'",
            [g, current.members.length > 1 ? "matched" : "needs_info", reason],
          );
      }
      return input.action === "connect" ? target : group.view.id;
    });
    await logEvent(
      "info",
      input.action === "connect"
        ? "matching.manual.connected"
        : "matching.manual.separated",
      "Manual product decision saved",
      { group_id: productId, action: input.action, actor },
    );
    return { ok: true, product_id: productId };
  } catch (error) {
    const concurrency =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ["40001", "40P01"].includes(String(error.code));
    if (error instanceof Conflict || concurrency) {
      const reason = concurrency
        ? "Products changed during this update. Reload and review them again."
        : (error as Conflict).message;
      await logEvent(
        "warn",
        "matching.manual.rejected",
        "Manual product change was not saved",
        { group_id: input.id, action: input.action, actor, reason },
      );
      return { ok: false, reason };
    }
    await logEvent(
      "error",
      "matching.manual.failed",
      "Manual product change failed",
      { group_id: input.id, action: input.action, actor },
    );
    throw error;
  }
}
