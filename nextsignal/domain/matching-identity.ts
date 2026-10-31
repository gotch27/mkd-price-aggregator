import { z } from "zod";
import { hash, normalizeName } from "./normalize";
import { readableProductText } from "./product-text";
import { canonicalBrand, canonicalType, factLabels } from "./product-facts";
import { identityValue, relevantBrandRules } from "./identity-values";
import {
  differences,
  evidenceGaps,
  factNames,
  refreshProductFacts,
  requestProduct,
  type Fact,
  type FactName,
  type Facts,
  type StoreProduct,
  type CategoryMapping,
  type Candidate,
} from "./matching";
import type { LocalMatchingRules } from "./local-matching";
export const identityRoutes = [
  "none",
  "brand",
  "type",
  "amount",
  "flavour",
  "formulation",
  "pack",
  "container",
  "missing_from_source",
  "other",
] as const;
export type IdentityRoute = (typeof identityRoutes)[number];

export const identityCatalogSchema = z.strictObject({
  version: z.string().min(1),
  routing: z.record(z.enum(identityRoutes), z.string().min(1)),
  profiles: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        types: z.array(z.string()).min(1),
        required: z.array(z.enum(factNames)),
        identity_any: z.array(z.enum(factNames)),
        type_aliases: z.array(z.string().min(1)),
      }),
    )
    .min(1),
  aliases: z.record(
    z.string(),
    z.record(z.string(), z.array(z.string().min(1))),
  ),
  type_parents: z.record(z.string(), z.string()),
  forbidden_type_contexts: z.record(z.string(), z.array(z.string())),
});
export type IdentityCatalog = z.infer<typeof identityCatalogSchema>;
export type FactStatus = "known" | "absent" | "ambiguous" | "unrecognized";
export type IdentityState = {
  profile: string;
  statuses: Record<FactName, FactStatus>;
  key: string;
};
export type IdentityProduct = StoreProduct & { identity?: IdentityState };
const word = (text: string, phrase: string) =>
  ` ${text.replace(/(?<=[a-z])[.]+/g, " ")} `.includes(
    ` ${normalizeName(phrase)} `,
  );
const value = (p: StoreProduct, k: FactName) => p.facts[k]?.value ?? null;
export function identityInputKey(
  p: StoreProduct,
  catalog: IdentityCatalog,
  rules: LocalMatchingRules,
) {
  return hash({
    source: [p.id, p.fingerprint, p.name, p.description, p.category, p.gtin],
    manual: p.manual_facts ?? {},
    family: p.manual_family ?? p.classified_family ?? p.family,
    catalog,
    rules: relevantBrandRules(
      [
        p.name,
        p.description ?? "",
        p.category ?? "",
        p.manual_facts?.brand ?? "",
      ],
      rules,
    ),
  });
}
function canonical(
  field: FactName,
  v: string,
  c: IdentityCatalog,
  r: LocalMatchingRules,
) {
  const t = normalizeName(v);
  if (field === "brand") return canonicalBrand(v, r);
  if (field === "type") {
    const exact = c.profiles.find(
      (p) => p.types.includes(v) || p.type_aliases.some((a) => word(t, a)),
    );
    return exact
      ? exact.types.includes(v)
        ? v
        : exact.types[0]
      : (canonicalType(v) ?? t);
  }
  const aliases = c.aliases[field];
  const exact =
    aliases &&
    Object.entries(aliases).find(
      ([name, list]) => name === v || list.some((a) => normalizeName(a) === t),
    );
  return exact?.[0] ?? v;
}
export function identityProfile(p: StoreProduct, c: IdentityCatalog) {
  return c.profiles.find((profile) =>
    profile.types.includes(value(p, "type") ?? ""),
  );
}
export function prepareIdentity(
  p: StoreProduct,
  rules: LocalMatchingRules,
  mappings: CategoryMapping[],
  catalog: IdentityCatalog,
): IdentityProduct {
  const base = refreshProductFacts(p, rules, mappings);
  const facts: Facts = { ...base.facts };
  const sources = (["name", "description", "category"] as const).flatMap(
    (source) =>
      p[source]
        ? [
            {
              source,
              raw: p[source]!,
              text: normalizeName(
                readableProductText(
                  source === "description"
                    ? p[source]!.split(
                        /(?:состав\s*:|ingredients\s*:|нутритивни|нутритивна|nutritional|nutrition\s*:)/iu,
                      )[0]
                    : p[source]!,
                  p.retailer,
                ),
              ),
            },
          ]
        : [],
  );
  const put = (
    field: FactName,
    v: string,
    source: (typeof sources)[number],
  ) => {
    facts[field] = {
      value: v,
      literal: source.raw,
      status: "known",
      source: source.source,
      quote: source.raw,
      method: "rule",
    };
  };
  // A leading brand in a descriptive product label is useful evidence. Do not
  // infer a brand from a manufacturer/ingredient mentioned later in the text.
  if (!facts.brand) {
    const description = sources.find((s) => s.source === "description");
    if (description) {
      const brands = rules.brands.filter((b) =>
        b.aliases.some(
          (alias) =>
            description.text === normalizeName(alias) ||
            description.text.startsWith(`${normalizeName(alias)} `),
        ),
      );
      if (brands.length === 1) put("brand", brands[0].canonical, description);
    }
  }
  const supportedFamilies = ["soft_drinks", "dairy"].includes(base.family);
  if (supportedFamilies) {
    // A fruit/flavour in a beverage name is not its generic product type.
    if (
      catalog.forbidden_type_contexts[base.family]?.includes(
        facts.type?.value ?? "",
      )
    )
      delete facts.type;
    const candidates = sources.flatMap((source, sourceIndex) =>
      catalog.profiles.flatMap((profile) =>
        profile.type_aliases
          .filter((a) => word(source.text, a))
          .map((alias) => ({
            profile,
            source,
            score: (3 - sourceIndex) * 100 + normalizeName(alias).length,
            alias,
          })),
      ),
    );
    const detected = candidates.sort(
      (a, b) => b.score - a.score || a.profile.id.localeCompare(b.profile.id),
    )[0];
    if (detected) {
      let t = detected.profile.types[0];
      if (detected.profile.id === "other-dairy")
        t = /puter|butter/.test(detected.alias)
          ? "butter"
          : /cream|pavlaka/.test(detected.alias)
            ? "cream"
            : "cheese";
      // "sok" is also used for fizzy drinks; do not assert fruit juice from it.
      if (
        detected.profile.id === "juice" &&
        ["sok", "sokche", "pijalak", "pijalok", "dzhus"].includes(
          detected.alias,
        )
      )
        t = "soft-drink";
      if (facts.type?.value !== "cola") put("type", t, detected.source);
    }
    for (const [field, aliases] of Object.entries(catalog.aliases)) {
      const k = field as FactName;
      if (!factNames.includes(k))
        throw new Error(`Unsupported identity field ${field}`);
      for (const source of sources) {
        const matches = Object.entries(aliases).filter(([, list]) =>
          list.some((a) => word(source.text, a)),
        );
        if (!matches.length) continue;
        // Ingredient lists and broad shelf categories must not add flavours.
        if (
          source.source === "category" &&
          ["flavour", "variant", "range"].includes(k)
        )
          continue;
        if (matches.length === 1) put(k, matches[0][0], source);
        else if (k === "flavour")
          put(
            k,
            matches
              .map(([v]) => v)
              .sort()
              .join("+"),
            source,
          );
        break;
      }
    }
    // A percentage in a drink label is not proof of its dairy fat content.
    if (base.family !== "dairy") delete facts.fat;
  }
  // Retain source-supported interpretation; manual corrections win last.
  for (const [field, fact] of Object.entries(p.facts) as [FactName, Fact][]) {
    if (
      fact.method === "qwen" &&
      fact.source !== "manual" &&
      p[fact.source]?.includes(fact.quote) &&
      !facts[field]
    )
      facts[field] = {
        ...fact,
        value:
          field === "brand"
            ? canonical(
                field,
                readableProductText(fact.literal ?? fact.value, p.retailer),
                catalog,
                rules,
              )
            : canonical(field, fact.value, catalog, rules),
      };
  }
  for (const field of factNames) {
    if (facts[field]) {
      const normalized = identityValue(
        field,
        facts[field]!.value,
        catalog,
        rules,
      );
      facts[field] = {
        ...facts[field]!,
        value: canonical(field, facts[field]!.value, catalog, rules),
        status: facts[field]!.method === "rule" ? "known" : normalized.status,
      };
      if (field === "brand") {
        const linked = rules.brands.find((b) =>
          [b.canonical, ...b.aliases].some(
            (a) => normalizeName(a) === normalizeName(facts.brand!.value),
          ),
        );
        facts.brand = { ...facts.brand!, reference: linked?.canonical };
      }
    }
    const manual = p.manual_facts?.[field];
    if (manual === null) delete facts[field];
    else if (manual !== undefined)
      facts[field] = {
        value: canonical(field, manual, catalog, rules),
        quote: manual,
        source: "manual",
        method: "manual",
        status: "known",
      };
  }
  const result = { ...base, facts };
  const statuses = Object.fromEntries(
    factNames.map((k) => [
      k,
      !facts[k]
        ? "absent"
        : facts[k]!.status === "unrecognized" ||
            (k === "type" && !canonicalType(facts[k]!.value))
          ? "unrecognized"
          : "known",
    ]),
  ) as Record<FactName, FactStatus>;
  const brandMatches = rules.brands.filter((b) =>
    sources.some((s) => b.aliases.some((a) => word(s.text, a))),
  );
  if (brandMatches.length > 1 && !facts.brand) statuses.brand = "ambiguous";
  return {
    ...result,
    identity: {
      profile: identityProfile(result, catalog)?.id ?? "conservative",
      statuses,
      key: identityInputKey(p, catalog, rules),
    },
  };
}
function isAncestor(a: string, b: string, c: IdentityCatalog) {
  const seen = new Set<string>();
  for (
    let parent = c.type_parents[b];
    parent && !seen.has(parent);
    parent = c.type_parents[parent]
  ) {
    if (parent === a) return true;
    seen.add(parent);
  }
  return false;
}
export function identityDifferences(
  a: StoreProduct,
  b: StoreProduct,
  c: IdentityCatalog,
) {
  return differences(a, b).filter((reason) => {
    const field = reason.split(":")[0] as FactName;
    if (
      a.facts[field]?.status === "unrecognized" ||
      b.facts[field]?.status === "unrecognized"
    )
      return false;
    if (
      field === "brand" &&
      a.facts.brand?.method !== "manual" &&
      b.facts.brand?.method !== "manual" &&
      (!a.facts.brand?.reference || !b.facts.brand?.reference)
    )
      return false;
    if (!reason.startsWith("type:")) return true;
    const x = value(a, "type"),
      y = value(b, "type");
    return !!x && !!y && !isAncestor(x, y, c) && !isAncestor(y, x, c);
  });
}
export function identityGaps(
  a: StoreProduct,
  b: StoreProduct,
  c: IdentityCatalog,
): string[] {
  if (a.ambiguous || b.ambiguous || a.branch_conflict || b.branch_conflict)
    return ["Source identity needs attention"];
  const conflicts = identityDifferences(a, b, c);
  if (conflicts.length) return conflicts;
  if (value(a, "gtin") && value(a, "gtin") === value(b, "gtin")) return [];
  if (a.local_key && a.local_key === b.local_key) return [];
  const unrecognized = factNames.filter(
    (k) =>
      a.facts[k]?.status === "unrecognized" ||
      b.facts[k]?.status === "unrecognized",
  );
  if (unrecognized.length)
    return unrecognized.map(
      (k) => `Unrecognized ${factLabels[k]} needs interpretation`,
    );
  if (
    a.facts.brand &&
    b.facts.brand &&
    a.facts.brand.value !== b.facts.brand.value
  )
    return ["Brand spellings need review"];
  const pa = identityProfile(a, c),
    pb = identityProfile(b, c);
  if (!["soft_drinks", "dairy"].includes(a.family) || !pa || !pb)
    return evidenceGaps(a, b);
  const required = new Set([...pa.required, ...pb.required]);
  const gaps = [...required]
    .filter((k) => !value(a, k) || !value(b, k))
    .map((k) => `Missing ${factLabels[k]}`);
  for (const [p, profile] of [
    [a, pa],
    [b, pb],
  ] as const)
    if (
      profile.identity_any.length &&
      !profile.identity_any.some((k) => value(p, k))
    )
      gaps.push(
        `Missing product line, flavour or formulation in ${p.retailer}`,
      );
  for (const k of [
    "variant",
    "pack",
    "form",
    "fat",
    "alcohol",
    "model",
    "size",
    "range",
    "flavour",
    "processing",
    "shade",
    "grade",
    "carbonation",
  ] as FactName[])
    if (!!value(a, k) !== !!value(b, k))
      gaps.push(`Missing ${factLabels[k]} in one store`);
  return [...new Set(gaps)];
}
export function identityFields(
  p: StoreProduct,
  c: IdentityCatalog,
  peers: StoreProduct[] = [],
): FactName[] {
  const profile = identityProfile(p, c);
  const generic: FactName[] = ["brand", "type"];
  if (["fruit", "vegetables"].includes(p.family))
    generic.splice(0, generic.length, "type", "variety", "sale_unit");
  else if (value(p, "type") === "eye-pencil") generic.push("range", "shade");
  else if (p.family === "baby_care") generic.push("size", "pack", "variant");
  else if (["household", "clothing_accessories"].includes(p.family))
    generic.push("model");
  else generic.push("quantity", "unit");
  const wanted = new Set<FactName>([...generic, ...(profile?.required ?? [])]);
  if (
    profile?.identity_any.length &&
    !profile.identity_any.some((k) => value(p, k))
  )
    for (const k of profile.identity_any) wanted.add(k);
  if (
    !profile &&
    ["personal_care", "automotive", "pet"].includes(p.family) &&
    !["variant", "fat", "range", "flavour", "shade"].some(
      (k) => p.facts[k as FactName],
    )
  )
    wanted.add("variant");
  for (const k of [
    "variant",
    "pack",
    "form",
    "fat",
    "alcohol",
    "model",
    "size",
    "range",
    "flavour",
    "processing",
    "shade",
    "grade",
    "carbonation",
  ] as FactName[])
    if (peers.some((other) => other.facts[k])) wanted.add(k);
  const missing = [...wanted].filter(
    (k) =>
      (!p.facts[k] ||
        p.facts[k]?.status === "unrecognized" ||
        (k === "type" && !canonicalType(p.facts[k]!.value))) &&
      !Object.hasOwn(p.manual_facts ?? {}, k),
  );
  if (missing.includes("quantity") || missing.includes("unit")) {
    if (
      !Object.hasOwn(p.manual_facts ?? {}, "quantity") &&
      !Object.hasOwn(p.manual_facts ?? {}, "unit")
    )
      return [...new Set<FactName>([...missing, "quantity", "unit"])];
    return missing.filter((k) => k !== "quantity" && k !== "unit");
  }
  return missing;
}
// Matching receives source evidence and unresolved fields. Classification uses
// its own stable input and is unaffected by changes to these profiles.
export function identityRequest(p: StoreProduct, c: IdentityCatalog) {
  return {
    ...requestProduct(p),
    identity_profile: identityProfile(p, c)?.id ?? "conservative",
    supported_facts: p.facts,
    unresolved_fields: identityFields(p, c),
  };
}
export function identityGroupProblem(
  members: StoreProduct[],
  c: IdentityCatalog,
  manual: (a: string, b: string) => boolean = () => false,
): string | null {
  if (new Set(members.map((p) => p.retailer)).size !== members.length)
    return "Two distinct products from the same store would enter the group";
  for (const p of members)
    if (p.ambiguous || p.branch_conflict || p.state === "legacy_conflict")
      return "Source identity needs attention";
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) {
      const differences = identityDifferences(members[i], members[j], c);
      if (differences.length) return differences.join("; ");
      if (!manual(members[i].id, members[j].id)) {
        const gaps = identityGaps(members[i], members[j], c);
        if (gaps.length) return `Complete group: ${gaps.join("; ")}`;
      }
    }
  return null;
}
export function unambiguousGroups(
  query: StoreProduct,
  candidates: Candidate[],
) {
  const owner = new Map<string, Set<string>>();
  for (const candidate of candidates)
    for (const member of candidate.members) {
      const ids = owner.get(member.retailer) ?? new Set<string>();
      ids.add(candidate.product.group_id);
      owner.set(member.retailer, ids);
    }
  const held = new Set<string>();
  for (const candidate of candidates)
    for (const member of candidate.members)
      if (
        member.retailer === query.retailer ||
        (owner.get(member.retailer)?.size ?? 0) > 1
      )
        held.add(candidate.product.group_id);
  return {
    accepted: candidates.filter((p) => !held.has(p.product.group_id)),
    held,
  };
}
