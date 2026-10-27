import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { Attributes, CatalogRow } from "./types";
import { decodeLegacyMacedonian } from "@/nextsignal/domain/name-encoding";
import { packCount } from "@/nextsignal/domain/pack-count";
export const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest("hex");
const cyrillic: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  ѓ: "gj",
  е: "e",
  ж: "zh",
  з: "z",
  ѕ: "dz",
  и: "i",
  ј: "j",
  к: "k",
  л: "l",
  љ: "lj",
  м: "m",
  н: "n",
  њ: "nj",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  ќ: "kj",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "ch",
  џ: "dzh",
  ш: "sh",
  č: "ch",
  š: "sh",
  ž: "zh",
  ć: "kj",
  đ: "gj",
  ǵ: "gj",
  ḱ: "kj",
};
export function normalizeName(value: string) {
  return decodeLegacyMacedonian(value.normalize("NFKC"))
    .toLowerCase()
    .replace(/[а-шѓќѕјљњџčšžćđǵḱ]/g, (c) => cyrillic[c] ?? c)
    .replace(/[^a-z0-9.%]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
export function money(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const macedonianCurrency = /ден/i.test(String(value));
  let s = String(value)
    .trim()
    .replace(/(?:денари|ден\.?|mkd)/gi, "")
    .replace(/\s/g, "");
  if (!s || s === "-" || s === "/") return null;
  if (macedonianCurrency && /^\d{1,3}(?:\.\d{3})+$/.test(s))
    s = s.replaceAll(".", "");
  if (s.includes(",") && s.includes("."))
    s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const n = new Decimal(s);
  if (n.isNegative() || n.decimalPlaces() > 2) return null;
  return n.toFixed(2);
}
export function validGtin(raw: string | null) {
  if (!raw || !/^\d{8}$|^\d{12,14}$/.test(raw) || /^0+$/.test(raw))
    return false;
  const digits = [...raw].map(Number);
  const check = digits.pop()!;
  return (
    (10 -
      (digits
        .reverse()
        .reduce((sum, n, i) => sum + n * (i % 2 === 0 ? 3 : 1), 0) %
        10)) %
      10 ===
    check
  );
}
export function attributes(
  row: Pick<CatalogRow, "name" | "category" | "gtin">,
): Attributes {
  const text = normalizeName(row.name.replace(/,/g, "."));
  const quantities = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(ml|l|gr|g|kg)\b/g)];
  const found = quantities[0];
  let quantity: string | null = null,
    unit: Attributes["unit"] = null,
    ambiguous = quantities.length > 1;
  if (found) {
    const n = new Decimal(found[1]);
    unit = ["ml", "l"].includes(found[2]) ? "ml" : "g";
    quantity = n.mul(["l", "kg"].includes(found[2]) ? 1000 : 1).toString();
    if (/\d\s*[-–—]\s*\d+\s*(?:кг|гр|kg|gr|г|g)(?!\p{L})/iu.test(row.name))
      ambiguous = true;
    if (["ml", "gr", "g"].includes(found[2]) && /^\d\.\d{3}$/.test(found[1]))
      ambiguous = true;
  }
  const pack = packCount(row.name)?.value ?? null;
  const brand =
    /\b(koka kola|coca cola)\b/.test(text) &&
    !/haribo|minicco|gumeni|bonboni/.test(text)
      ? "coca-cola"
      : null;
  const variant = /\b(zero|zero sugar|zero shekjer)\b/.test(text)
    ? "zero"
    : /\b(klasik|classic|original)\b/.test(text)
      ? "classic"
      : null;
  const form = /limenka|\bcan\b/.test(text)
    ? "can"
    : /\bpet\b|plastic/.test(text)
      ? "plastic-bottle"
      : null;
  return {
    brand,
    variant,
    quantity,
    unit,
    pack,
    form,
    gtin: validGtin(row.gtin) ? row.gtin : null,
    ambiguous,
  };
}
export function conflicts(a: Attributes, b: Attributes) {
  return (
    a.ambiguous ||
    b.ambiguous ||
    (
      ["brand", "variant", "quantity", "unit", "pack", "form", "gtin"] as const
    ).some((k) => a[k] !== null && b[k] !== null && a[k] !== b[k])
  );
}
export function canonicalAttributes(a: Attributes): Attributes {
  const normalized = (s: string | null) =>
    s === null ? null : normalizeName(s);
  let brand = normalized(a.brand),
    variant = normalized(a.variant),
    form = normalized(a.form);
  if (brand && /^(coca cola|koka kola)$/.test(brand)) brand = "coca-cola";
  if (variant && /^(zero|zero sugar|zero shekjer)$/.test(variant))
    variant = "zero";
  if (variant && /^(klasik|classic|original)$/.test(variant))
    variant = "classic";
  if (form && /^(limenka|can|cans)$/.test(form)) form = "can";
  if (form && /^(pet|plastic bottle|plastic bottle pet)$/.test(form))
    form = "plastic-bottle";
  if (form && /^(tetrapak|tetra pak|tetra pack)$/.test(form)) form = "tetrapak";
  return { ...a, brand, variant, form };
}
export function complete(a: Attributes) {
  return (
    !a.ambiguous &&
    (["brand", "variant", "quantity", "unit", "pack", "form"] as const).every(
      (k) => a[k] !== null,
    )
  );
}
export function identity(row: CatalogRow) {
  return hash([
    row.name,
    row.description,
    row.category,
    row.gtin,
    row.raw?.identity_ambiguous === true,
  ]);
}
