import Decimal from "decimal.js";
import type { FactName } from "./matching";

// Only measurements/counts are numbers. Product codes, sizes and shades can
// contain meaningful leading zeroes and must retain their original identity.
export function numericFactValue(field: FactName, value: string): string {
  if (!["quantity", "pack", "fat", "alcohol"].includes(field)) return value;
  const text = value.trim().replace(",", ".");
  const number = ["fat", "alcohol"].includes(field)
    ? text.replace(/\s*%$/, "")
    : text;
  if (!/^\d+(?:\.\d+)?$/.test(number)) return value;
  return new Decimal(number).toFixed();
}
