import Decimal from "decimal.js";
import { hash, normalizeName } from "@/nextsignal/domain/normalize";
import type { Attributes } from "@/nextsignal/domain/types";
import { NAME_NORMALIZATION_VERSION } from "@/nextsignal/domain/name-encoding";

export type LocalMatchingRules = {
  enabled: boolean;
  version: string;
  index_batch_size: number;
  brands: { canonical: string; aliases: string[] }[];
  token_aliases: Record<string, string[]>;
  ignored_tokens: string[];
};
export const localMatchingVersion = (
  rules: Pick<LocalMatchingRules, "version">,
) => `${rules.version}:${NAME_NORMALIZATION_VERSION}`;
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phrase = (value: string) =>
  new RegExp(`(^| )${escaped(normalizeName(value))}(?= |$)`, "g");

export function expandNameSearch(
  search: string,
  rules: LocalMatchingRules,
): string[] {
  const normalized = normalizeName(search);
  const terms = new Set([normalized]);
  if (!normalized || !rules.enabled) return [...terms];
  for (const brand of rules.brands) {
    const aliases = brand.aliases.map(normalizeName);
    const found = aliases.find((alias) => phrase(alias).test(normalized));
    if (found)
      for (const alias of aliases)
        terms.add(
          normalized
            .replace(phrase(found), ` ${alias}`)
            .trim()
            .replace(/\s+/g, " "),
        );
    else if (aliases.some((alias) => alias.startsWith(`${normalized} `)))
      for (const alias of aliases) terms.add(alias);
  }
  return [...terms];
}

// Exact canonical signatures, never a similarity score. Every remaining token
// participates, so unknown flavor, fat percentage, package and variant words
// prevent a match instead of being silently discarded.
export function localRuleKey(
  name: string,
  attrs: Attributes,
  rules: LocalMatchingRules,
): string | null {
  if (
    !rules.enabled ||
    attrs.ambiguous ||
    attrs.quantity === null ||
    attrs.unit === null
  )
    return null;
  let text = normalizeName(
    name.replace(/,/g, ".").replace(/(\d+)\s*[xх*]\s*(?=\d)/giu, "$1x"),
  );
  const brands = rules.brands.filter((brand) =>
    brand.aliases.some((alias) => phrase(alias).test(text)),
  );
  if (brands.length !== 1) return null;
  const brand = brands[0];
  for (const alias of [...brand.aliases].sort((a, b) => b.length - a.length))
    text = text.replace(phrase(alias), " ");
  text = text.replace(
    /(\d+(?:\.\d+)?)\s*(ml|l|gr|g|kg)\b/g,
    (_whole, n, unit) => {
      const quantity = new Decimal(n)
        .mul(unit === "l" || unit === "kg" ? 1000 : 1)
        .toString();
      return ` quantity${quantity}${unit === "l" || unit === "ml" ? "ml" : "g"} `;
    },
  );
  for (const [canonical, aliases] of Object.entries(rules.token_aliases))
    for (const alias of [...aliases].sort((a, b) => b.length - a.length))
      text = text.replace(phrase(alias), ` ${canonical} `);
  for (const token of rules.ignored_tokens)
    text = text.replace(phrase(token), " ");
  const tokens = text.trim().split(/\s+/).filter(Boolean).sort();
  if (
    !tokens.some(
      (token) => !/^quantity\d/.test(token) && !/^\d+x?$/.test(token),
    )
  )
    return null;
  return hash({
    version: localMatchingVersion(rules),
    brand: brand.canonical,
    tokens,
    pack: attrs.pack,
    quantity: attrs.quantity,
    unit: attrs.unit,
  });
}
