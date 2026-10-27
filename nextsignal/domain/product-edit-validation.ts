import Decimal from "decimal.js";
import { validGtin } from "@/nextsignal/domain/normalize";
import type { DetailOverrides } from "@/nextsignal/domain/product-edits";
import type { Facts } from "@/nextsignal/domain/matching";

export class ProductEditValidation extends Error {}
// Validate human input separately from model evidence. Clearing a field is an
// explicit unknown value; resetting removes the override and restores sources.
export function validateDetailOverrides(
  overrides: DetailOverrides,
  base: Facts,
) {
  const next = { ...overrides };
  for (const [field, value] of Object.entries(next)) {
    if (value == null) continue;
    const text = value.trim();
    if (!text) {
      next[field as keyof DetailOverrides] = null;
      continue;
    }
    if (!/[\p{L}\p{N}]/u.test(text))
      throw new ProductEditValidation(
        `Enter a readable value for ${field}, or clear it.`,
      );
    if (["quantity", "pack", "fat", "alcohol"].includes(field)) {
      if (!/^\d+(?:[.,]\d+)?$/.test(text))
        throw new ProductEditValidation(`${field} must be a valid number.`);
      const number = new Decimal(text.replace(",", "."));
      if (["quantity", "pack"].includes(field) && number.lte(0))
        throw new ProductEditValidation(
          "Amount and pack count must be greater than zero.",
        );
      if (
        field === "pack" &&
        (!number.isInteger() || number.gt(Number.MAX_SAFE_INTEGER))
      )
        throw new ProductEditValidation(
          "Items in pack must be a whole number.",
        );
      if (["fat", "alcohol"].includes(field) && number.gt(100))
        throw new ProductEditValidation(
          "Percentages must be between 0 and 100.",
        );
      next[field as keyof DetailOverrides] = number.toString();
    } else next[field as keyof DetailOverrides] = text;
  }
  if (next.gtin != null && !validGtin(next.gtin))
    throw new ProductEditValidation(
      "Enter a valid barcode, including its check digit.",
    );
  const quantity =
    next.quantity === undefined ? base.quantity?.value : next.quantity;
  const unit = next.unit === undefined ? base.unit?.value : next.unit;
  if (!!quantity !== !!unit)
    throw new ProductEditValidation(
      "Enter both an amount and its unit, or clear both.",
    );
  if (unit && !["g", "kg", "ml", "l", "piece"].includes(unit))
    throw new ProductEditValidation(
      "Choose g, kg, ml, l or piece as the unit.",
    );
  // Amount edits always persist together with their unit, so a later source
  // refresh cannot change only one half of a human correction.
  if (next.quantity !== undefined || next.unit !== undefined) {
    next.quantity =
      quantity == null
        ? null
        : new Decimal(quantity)
            .mul(["kg", "l"].includes(unit!) ? 1000 : 1)
            .toString();
    next.unit =
      unit == null ? null : unit === "kg" ? "g" : unit === "l" ? "ml" : unit;
  }
  return next;
}
