import { normalizeName } from "./normalize";
import { canonicalBrand, canonicalType } from "./product-facts";
import type { FactName } from "./matching";
import type { LocalMatchingRules } from "./local-matching";
import type { IdentityCatalog } from "./matching-identity";

export function identityValue(
  field: FactName,
  literal: string,
  catalog: IdentityCatalog,
  rules: LocalMatchingRules,
): { value: string; status: "known" | "unrecognized" } {
  const text = normalizeName(literal);
  if (field === "brand")
    return { value: canonicalBrand(literal, rules), status: "known" };
  if (field === "type") {
    const type =
      canonicalType(literal) ??
      catalog.profiles.find((p) =>
        p.type_aliases.some((a) => normalizeName(a) === text),
      )?.types[0];
    return { value: type ?? text, status: type ? "known" : "unrecognized" };
  }
  const aliases = catalog.aliases[field];
  if (aliases) {
    const direct = Object.entries(aliases).find(
      ([canonical, list]) =>
        canonical === literal || list.some((a) => normalizeName(a) === text),
    );
    if (direct) return { value: direct[0], status: "known" };
    if (field === "flavour") {
      let remaining = ` ${text} `;
      const values = new Set<string>();
      const terms = Object.entries(aliases)
        .flatMap(([value, list]) =>
          list.map((a) => ({ value, term: normalizeName(a) })),
        )
        .sort((a, b) => b.term.length - a.term.length);
      for (const { value, term } of terms)
        if (remaining.includes(` ${term} `)) {
          remaining = remaining.replaceAll(` ${term} `, " ");
          values.add(value);
        }
      if (
        values.size &&
        !remaining.replace(/\b(?:i|and|so|with)\b/g, "").trim()
      )
        return { value: [...values].sort().join("+"), status: "known" };
    }
    return { value: text, status: "unrecognized" };
  }
  return { value: text, status: "known" };
}

export function relevantBrandRules(texts: string[], rules: LocalMatchingRules) {
  const text = ` ${texts.map(normalizeName).join(" ")} `;
  return {
    ...rules,
    brands: rules.brands.flatMap((b) => {
      const aliases = b.aliases.filter((a) =>
        text.includes(` ${normalizeName(a)} `),
      );
      return aliases.length ? [{ canonical: b.canonical, aliases }] : [];
    }),
  };
}
