import { hash } from "@/nextsignal/domain/normalize";
import { inputFingerprint } from "@/nextsignal/domain/matching";
import type { CatalogRow } from "@/nextsignal/domain/types";

// Occurrence numbers identify observations, not separate sellable products.
// Keep the first-occurrence key shape to preserve existing canonical IDs.
export function storeProductKey(key: string, base?: string | null) {
  return base ? `${base}:1` : key;
}

export function descriptiveFingerprint(row: CatalogRow) {
  return inputFingerprint({ ...row, ambiguous: false });
}

export function offerFingerprint(row: CatalogRow) {
  return hash([
    row.price,
    row.regular_price,
    row.promo_price,
    row.unit_price,
    row.available,
    row.promotion,
  ]);
}

export function duplicateSummary(rows: CatalogRow[]) {
  const identities = new Set<string>();
  const observations = new Set<string>();
  for (const row of rows) {
    const key = `${storeProductKey(row.key, typeof row.raw.identity_base === "string" ? row.raw.identity_base : null)}:${descriptiveFingerprint(row)}`;
    identities.add(key);
    observations.add(`${key}:${offerFingerprint(row)}`);
  }
  return {
    source_rows: rows.length,
    unique_products: identities.size,
    repeated_product_rows: rows.length - identities.size,
    identical_duplicate_rows: rows.length - observations.size,
  };
}
