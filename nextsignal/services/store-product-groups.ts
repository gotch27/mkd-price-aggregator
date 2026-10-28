import { readCatalog, rulesFromCatalog } from "./brand-catalog";
import type { PoolClient } from "pg";
import { settings } from "@/nextsignal/config";
import { indexListings } from "@/nextsignal/services/matching-repository";
import { hash } from "@/nextsignal/domain/normalize";
import {
  differences,
  refreshProductFacts,
  inputFingerprint,
  type StoreProduct,
  type ProductInput,
} from "@/nextsignal/domain/matching";
import type {
  ManualGroup,
  ManualMember,
} from "@/nextsignal/domain/manual-matching";

export type Member = StoreProduct & {
  listing_id: string | null;
  indexed: boolean;
  active: boolean;
};
export type Group = { view: ManualGroup; members: Member[] };
export class ProductGroupConflict extends Error {}
const limits = settings.matching.manual;
const active = `EXISTS(SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active WHERE ss.store_product_id=sp.id)`;

export async function readGroup(
  c: Pick<PoolClient, "query">,
  id: string,
  includeInactive = false,
): Promise<Group | null> {
  const root = (
    await c.query(
      `WITH RECURSIVE roots AS (
    SELECT id,redirect_id FROM products WHERE id=$1 UNION
    SELECT p.id,p.redirect_id FROM products p JOIN roots r ON p.id=r.redirect_id
  ) SELECT p.id,p.matching_version::int,p.matching_conflict FROM roots r JOIN products p ON p.id=r.id WHERE r.redirect_id IS NULL`,
      [id],
    )
  ).rows[0];
  if (!root) return null;
  const rows = (
    await c.query<Member>(
      `WITH members AS (
    SELECT sp.id,sp.retailer,sp.external_key,sp.name,sp.description,sp.category,sp.gtin,sp.ambiguous,sp.fingerprint,sp.facts,sp.family,
      sp.branch_conflict,sp.state,sp.version::int,sp.normalized_name,true AS indexed,NULL::uuid AS listing_id,${active} AS active,sp.manual_facts,sp.classified_family,sp.manual_family
    FROM store_products sp WHERE sp.group_id=$1 AND NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id)
    UNION ALL
    SELECT l.id,l.retailer,l.external_key,l.name,l.description,l.category,l.gtin,coalesce((l.raw->>'identity_ambiguous')::boolean,false),
      l.identity_hash,'{}'::jsonb,'unknown',false,'pending',0,l.normalized_name,false,l.id,true,'{}'::jsonb,NULL::text,NULL::text
    FROM catalog_browser b JOIN listings l ON l.id=b.listing_id
    WHERE l.product_id=$1 AND NOT EXISTS(SELECT 1 FROM store_product_aliases a WHERE a.listing_id=l.id)
  ) SELECT *,$1::uuid AS group_id FROM members ORDER BY retailer,id LIMIT $2`,
      [root.id, limits.group_member_limit + 1],
    )
  ).rows;
  const limited = rows.length > limits.group_member_limit;
  const catalog = await readCatalog(c);
  const all = rows.slice(0, limits.group_member_limit).map((r) => ({
    ...refreshProductFacts(
      { ...r, group_version: root.matching_version },
      rulesFromCatalog(catalog, r.retailer),
      settings.matching.category_mappings,
    ),
    indexed: r.indexed,
    listing_id: r.listing_id,
    active: r.active,
  }));
  const live =
    !includeInactive && all.some((r) => r.active)
      ? all.filter((r) => r.active)
      : all;
  const members = live.filter(
    (p, i) =>
      live.findIndex(
        (q) =>
          q.retailer === p.retailer &&
          q.external_key === p.external_key &&
          inputFingerprint(q) === inputFingerprint(p),
      ) === i,
  );
  const snapshot = hash([
    root.id,
    root.matching_version,
    root.matching_conflict,
    all.map((p) => [p.id, p.version, p.fingerprint, p.facts, p.active]).sort(),
    limited,
  ]);
  const view: ManualGroup = {
    id: root.id,
    snapshot,
    members: members.map(publicMember),
    conflict: root.matching_conflict,
    limited,
  };
  return { view, members };
}
const publicMember = (p: Member): ManualMember => ({
  id: p.id,
  indexed: p.indexed,
  retailer: p.retailer,
  name: p.name,
  description: p.description,
  category: p.category,
  facts: p.facts,
  active: p.active,
});

export async function indexMember(
  c: PoolClient,
  member: Pick<Member, "id" | "indexed"> & ProductInput,
) {
  if (member.indexed) return member.id;
  const rows = (
    await c.query(
      `SELECT l.id,l.retailer,l.external_key,l.raw->>'identity_base' AS identity_base,l.identity_hash,l.product_id,l.name,l.description,l.category,l.gtin,
    coalesce((l.raw->>'identity_ambiguous')::boolean,false) AS ambiguous,l.match_status,s.id AS source_id
    FROM listings selected JOIN listings l ON l.retailer=selected.retailer AND l.external_key=selected.external_key AND l.identity_hash=selected.identity_hash
    JOIN sources s ON s.retailer=l.retailer AND s.external_id=l.namespace
    WHERE selected.id=$1 ORDER BY l.id LIMIT $2 FOR UPDATE OF l`,
      [member.id, settings.maintenance.batch_size + 1],
    )
  ).rows;
  if (rows.length > settings.maintenance.batch_size)
    throw new ProductGroupConflict(
      "This product has too many branch records for a manual update. Finish its bounded indexing first.",
    );
  const identical = rows.filter(
    (r) => inputFingerprint(r) === inputFingerprint(member),
  );
  if (!identical.length)
    throw new ProductGroupConflict(
      "The store description changed. Reload and review it again.",
    );
  await indexListings(c, identical);
  const id = (
    await c.query<{ store_product_id: string }>(
      "SELECT store_product_id FROM store_product_aliases WHERE listing_id=$1",
      [member.id],
    )
  ).rows[0]?.store_product_id;
  if (!id)
    throw new ProductGroupConflict(
      "The store product could not be prepared. Reload and try again.",
    );
  await c.query(
    `INSERT INTO store_product_sources(store_product_id,source_id,price,highest_price,offer_count,retrieved_at)
    SELECT a.store_product_id,o.source_id,min(o.price),max(o.price),count(*)::int,max(o.retrieved_at)
    FROM store_product_aliases a JOIN offers o ON o.listing_id=a.listing_id AND o.source_id=a.source_id WHERE a.store_product_id=$1
    GROUP BY a.store_product_id,o.source_id ON CONFLICT(store_product_id,source_id) DO UPDATE SET price=excluded.price,highest_price=excluded.highest_price,offer_count=excluded.offer_count,retrieved_at=excluded.retrieved_at`,
    [id],
  );
  return id;
}
export function knownConflict(members: Member[]) {
  if (new Set(members.map((p) => p.retailer)).size !== members.length)
    return "A group can contain only one distinct product from each store. Separate the competing product first.";
  if (members.some((p) => p.ambiguous || p.branch_conflict))
    return "A source product has conflicting descriptions. Resolve those before connecting it.";
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) {
      const conflicts = differences(members[i], members[j]);
      if (conflicts.length)
        return `Known product details disagree: ${conflicts.join("; ")}`;
    }
  return null;
}
