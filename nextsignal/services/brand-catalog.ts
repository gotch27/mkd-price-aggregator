import language from "@/reference-data/product-language.json";
import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import { settings } from "@/nextsignal/config";
import type { LocalMatchingRules } from "@/nextsignal/domain/local-matching";
import { pool } from "./database";

type CatalogRow = { slug: string; name: string; retailer: string | null };
const catalogs = new AsyncLocalStorage<CatalogRow[]>();
export async function readCatalog(c: Pick<PoolClient, "query">) {
  return (
    await c.query<CatalogRow>(
      `SELECT b.slug,a.normalized_name AS name,a.retailer FROM brands b JOIN brand_aliases a ON a.brand_id=b.id ORDER BY b.slug,a.normalized_name`,
    )
  ).rows;
}
// Each task batch uses one dictionary snapshot. No database transaction spans AI calls.
export async function withBrandCatalog<T>(
  work: () => Promise<T>,
  c: Pick<PoolClient, "query"> = pool,
): Promise<T> {
  if (catalogs.getStore()) return work();
  return catalogs.run(await readCatalog(c), work);
}
export async function matchingRules(
  c: Pick<PoolClient, "query"> = pool,
  retailer?: string,
): Promise<LocalMatchingRules> {
  const rows = catalogs.getStore() ?? (await readCatalog(c));
  return rulesFromCatalog(rows, retailer);
}
export function rulesFromCatalog(
  rows: CatalogRow[],
  retailer?: string,
): LocalMatchingRules {
  const brands = new Map<string, string[]>();
  for (const row of rows) {
    const aliases = brands.get(row.slug) ?? [];
    if (
      row.retailer === null ||
      retailer === undefined ||
      row.retailer === retailer
    )
      aliases.push(row.name);
    brands.set(row.slug, aliases);
  }
  return {
    ...settings.matching.local,
    ...language,
    brands: [...brands].map(([canonical, aliases]) => ({ canonical, aliases })),
  };
}
