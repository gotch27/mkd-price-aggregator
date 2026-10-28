import { randomUUID } from "node:crypto";
import {
  BrandConflict,
  type Brand,
  type BrandInput,
  type BrandPage,
  type BrandOption,
} from "@/nextsignal/domain/brands";
import { normalizeName } from "@/nextsignal/domain/normalize";
import { pool, transaction } from "./database";
import { logEvent } from "@/nextsignal/adapters/log-context";
const selected = `SELECT b.*,coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'retailer',a.retailer) ORDER BY a.retailer NULLS FIRST,a.name) FROM brand_aliases a WHERE a.brand_id=b.id),'[]'::jsonb) AS aliases,
 (SELECT count(*)::int FROM store_products sp WHERE sp.brand_id=b.id AND NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id)) product_count FROM brands b`;
export async function list(
  search: string,
  page: number,
  size: number,
): Promise<BrandPage> {
  const term = normalizeName(search).replace(/[\\%_]/g, "\\$&");
  return transaction(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const condition = `WHERE $1='' OR EXISTS(SELECT 1 FROM brand_aliases a WHERE a.brand_id=b.id AND a.normalized_name ILIKE '%'||$1||'%')`;
    const total = (
      await c.query(`SELECT count(*)::int total FROM brands b ${condition}`, [
        term,
      ])
    ).rows[0].total;
    const total_pages = Math.ceil(total / size),
      current = Math.min(page, Math.max(1, total_pages));
    const rows = (
      await c.query<Brand>(
        `${selected} ${condition} ORDER BY b.name,b.id LIMIT $2 OFFSET $3`,
        [term, size, (current - 1) * size],
      )
    ).rows;
    return { rows, total, page: current, page_size: size, total_pages };
  });
}
export async function options(): Promise<{ rows: BrandOption[] }> {
  return {
    rows: (
      await pool.query<BrandOption>(
        "SELECT id,name FROM brands ORDER BY name,id",
      )
    ).rows,
  };
}
export async function save(
  input: BrandInput,
  actor: string,
  id?: string,
  revision?: number,
): Promise<Brand> {
  const result = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('brand-catalog'))");
    const before = id
      ? (
          await c.query<Brand>(`${selected} WHERE b.id=$1 FOR UPDATE OF b`, [
            id,
          ])
        ).rows[0]
      : null;
    if (id && !before) throw new BrandConflict("Brand not found.");
    if (before && before.revision !== revision)
      throw new BrandConflict("This brand changed. Reload before saving.");
    const slug = before?.slug ?? normalizeName(input.name).replaceAll(" ", "-");
    if (!/[a-z0-9]/i.test(slug))
      throw new BrandConflict("Enter a readable brand name.");
    const target = id ?? randomUUID();
    const aliases = new Map<
      string,
      { name: string; normalized: string; retailer: string | null }
    >();
    for (const a of [
      { name: slug, retailer: null },
      { name: input.name, retailer: null },
      ...input.aliases,
    ]) {
      const normalized = normalizeName(a.name);
      if (!/[a-z0-9]/i.test(normalized))
        throw new BrandConflict("Enter a readable spelling.");
      aliases.set(`${a.retailer ?? ""}:${normalized}`, {
        name: a.name.trim(),
        normalized,
        retailer: a.retailer,
      });
    }
    for (const a of aliases.values()) {
      const conflict = (
        await c.query(
          `SELECT 1 FROM brand_aliases WHERE normalized_name=$1 AND brand_id<>$2 AND (retailer IS NULL OR $3::text IS NULL OR retailer=$3) LIMIT 1`,
          [a.normalized, target, a.retailer],
        )
      ).rowCount;
      if (conflict)
        throw new BrandConflict(
          `The spelling “${a.name}” already belongs to another brand in this scope.`,
        );
    }
    const duplicate = (
      await c.query("SELECT 1 FROM brands WHERE slug=$1 AND id<>$2", [
        slug,
        target,
      ])
    ).rowCount;
    if (duplicate)
      throw new BrandConflict(
        "This brand already exists. Edit its spellings instead.",
      );
    if (before)
      await c.query(
        "UPDATE brands SET name=$2,revision=revision+1,updated_at=now() WHERE id=$1",
        [target, input.name.trim()],
      );
    else
      await c.query("INSERT INTO brands(id,slug,name) VALUES($1,$2,$3)", [
        target,
        slug,
        input.name.trim(),
      ]);
    // Retain unchanged alias IDs so audits and any open editing sessions stay clear.
    const keep: string[] = [];
    for (const a of aliases.values()) {
      const existing = (
        await c.query(
          "SELECT id FROM brand_aliases WHERE brand_id=$1 AND normalized_name=$2 AND retailer IS NOT DISTINCT FROM $3",
          [target, a.normalized, a.retailer],
        )
      ).rows[0];
      if (existing) {
        await c.query("UPDATE brand_aliases SET name=$2 WHERE id=$1", [
          existing.id,
          a.name,
        ]);
        keep.push(existing.id);
      } else
        keep.push(
          (
            await c.query(
              "INSERT INTO brand_aliases(brand_id,name,normalized_name,retailer) VALUES($1,$2,$3,$4) RETURNING id",
              [target, a.name, a.normalized, a.retailer],
            )
          ).rows[0].id,
        );
    }
    await c.query(
      "DELETE FROM brand_aliases WHERE brand_id=$1 AND NOT(id=ANY($2::uuid[]))",
      [target, keep],
    );
    const after = (await c.query<Brand>(`${selected} WHERE b.id=$1`, [target]))
      .rows[0];
    await c.query(
      "INSERT INTO brand_edits(brand_id,actor,before_record,after_record) VALUES($1,$2,$3,$4)",
      [target, actor, before, after],
    );
    return after;
  });
  await logEvent(
    "info",
    id ? "brands.updated" : "brands.created",
    id ? "Brand and spellings updated" : "Brand created",
    {
      actor,
      brand_id: result.id,
      revision: result.revision,
      alias_count: result.aliases.length,
    },
  );
  return result;
}
