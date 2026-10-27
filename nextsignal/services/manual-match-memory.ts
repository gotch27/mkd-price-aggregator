import type { PoolClient } from "pg";

export const pairKey = (a: string, b: string) => [a, b].sort().join(":");
export async function manualLinks(c: PoolClient, ids: string[]) {
  const rows = (
    await c.query<{ a_id: string; b_id: string; action: "same" | "different" }>(
      `SELECT DISTINCT ON(a_id,b_id) a_id,b_id,action FROM manual_product_links
     WHERE a_id=ANY($1::uuid[]) AND b_id=ANY($1::uuid[]) ORDER BY a_id,b_id,id DESC`,
      [ids],
    )
  ).rows;
  return new Map(rows.map((r) => [pairKey(r.a_id, r.b_id), r.action]));
}
