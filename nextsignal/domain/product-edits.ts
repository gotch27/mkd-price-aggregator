import type { FactName, Facts } from "@/nextsignal/domain/matching";

export const productFields = [
  ["brand", "Brand"],
  ["type", "Product type"],
  ["quantity", "Amount per item"],
  ["unit", "Unit"],
  ["pack", "Items in pack"],
  ["variant", "Variant"],
  ["form", "Packaging"],
  ["gtin", "Barcode"],
  ["fat", "Fat (%)"],
  ["alcohol", "Alcohol (%)"],
  ["model", "Model"],
  ["size", "Product size"],
  ["range", "Range"],
  ["flavour", "Flavour / fragrance"],
  ["processing", "Processing"],
  ["shade", "Shade"],
  ["variety", "Variety"],
  ["sale_unit", "Sold by"],
  ["grade", "Grade"],
  ["origin", "Origin"],
] as const satisfies readonly (readonly [FactName, string])[];
export type DetailOverrides = Partial<Record<FactName, string | null>>;
export type ProductEditInput = {
  id: string;
  member_id: string;
  snapshot: string;
  action: "update" | "reset";
  changes: DetailOverrides;
  note: string;
};
export type DetailChange = {
  field: FactName;
  before: string | null;
  after: string | null;
};
export type ProductEditHistory = {
  id: string;
  actor: string;
  action: "update" | "reset";
  changes: DetailChange[];
  note: string;
  created_at: string;
};
export type EditableProduct = {
  id: string;
  member_id: string;
  snapshot: string;
  retailer: string;
  name: string;
  facts: Facts;
  overrides: DetailOverrides;
  history: ProductEditHistory[];
  history_total: number;
  limits: {
    value_max_length: number;
    note_max_length: number;
    history_limit: number;
  };
};
export type ProductEditResult =
  | { ok: true; changed: boolean; product_id: string }
  | { ok: false; reason: string };
