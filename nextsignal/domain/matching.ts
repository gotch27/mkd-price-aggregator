import Decimal from "decimal.js";
import { hash, normalizeName, validGtin } from "@/nextsignal/domain/normalize";
import {
  localRuleKey,
  type LocalMatchingRules,
} from "@/nextsignal/domain/local-matching";
import {
  hasReadableTextChange,
  readableProductCategory,
  productTextWarnings,
  readableProductText,
} from "@/nextsignal/domain/product-text";
import { packCount } from "@/nextsignal/domain/pack-count";
import {
  canonicalFactValue,
  canonicalType,
  productType,
  descriptiveFacts,
  factLabels,
} from "@/nextsignal/domain/product-facts";

export const families = [
  "fruit",
  "vegetables",
  "dairy",
  "alcohol",
  "soft_drinks",
  "other_food",
  "baby_food",
  "baby_care",
  "personal_care",
  "cleaning",
  "automotive",
  "clothing_accessories",
  "pet",
  "household",
  "other",
  "unknown",
] as const;
export type Family = (typeof families)[number];
export const factNames = [
  "brand",
  "type",
  "variant",
  "quantity",
  "unit",
  "pack",
  "form",
  "gtin",
  "fat",
  "alcohol",
  "model",
  "size",
  "variety",
  "sale_unit",
  "grade",
  "origin",
  "range",
  "flavour",
  "processing",
  "shade",
] as const;
export type FactName = (typeof factNames)[number];
export type Fact = {
  value: string;
  quote: string;
  source: "name" | "description" | "category" | "gtin" | "manual";
  method: "rule" | "qwen" | "manual";
};
export type Facts = Partial<Record<FactName, Fact>>;
export type ProductInput = {
  retailer?: string;
  name: string;
  description: string | null;
  category: string | null;
  gtin: string | null;
  ambiguous: boolean;
};
export type StoreProduct = ProductInput & {
  availability?: import("./availability").ProductAvailability;
  id: string;
  retailer: string;
  external_key: string;
  fingerprint: string;
  normalized_name: string;
  facts: Facts;
  family: Family;
  category_hints: Family[];
  local_key: string | null;
  group_id: string;
  group_version?: number;
  branch_conflict?: boolean;
  version: number;
  state: string;
  last_reason: string;
  classified_family?: Family | null;
  manual_family?: Family | null;
  category_review_source?: "human" | "agent" | null;
  category_review_actor?: string | null;
  category_reviewed_at?: string | null;
  category_review_reason?: string | null;
  classification_key?: string | null;
  classification_threshold?: number | null;
  manual_facts?: Partial<Record<FactName, string | null>>;
};
export type Candidate = {
  product: StoreProduct;
  members: StoreProduct[];
  group_version: number;
  reasons: string[];
  score: number;
};
export type Outcome =
  | "matched"
  | "different"
  | "needs_info"
  | "no_candidates"
  | "deferred"
  | "legacy_conflict"
  | "category_excluded"
  | "stale";
export type Comparison = {
  candidate: Candidate;
  outcome: Outcome;
  reason: string;
  method: "rules" | "decision";
  probability: number | null;
  confidence: number | null;
  prompt_key?: string | null;
};
export type CategoryMapping = {
  retailer: string;
  pattern: string;
  family: string;
};
export const valueOf = (facts: Facts, key: FactName) =>
  key === "type"
    ? canonicalType(facts[key]?.value ?? "")
    : (facts[key]?.value ?? null);
export const inputFingerprint = (input: ProductInput) =>
  hash({
    name: normalizeName(input.name.replaceAll(",", ".")),
    description:
      input.description === null ? null : normalizeName(input.description),
    category: input.category === null ? null : normalizeName(input.category),
    gtin: input.gtin,
    // Ambiguity describes source reliability, not a different product. Keep the
    // legacy unambiguous hash shape so saved IDs and matching inputs stay stable.
    ambiguous: false,
  });
const has = (text: string, pattern: string) =>
  new RegExp(`(?:^| )(?:${pattern})(?= |$)`, "iu").test(text);

export function familyFromText(
  input: ProductInput,
  retailer: string,
  mappings: CategoryMapping[],
): Family {
  const text = normalizeName(
    readableProductText(input.name, retailer).replace(
      /(?<=\p{L})[.!?]+/gu,
      " ",
    ),
  );
  const identified = productType(readableProductText(input.name, retailer));
  if (identified) return identified.family;
  if (
    has(text, "nutella|nutela") &&
    /kakao krem|eurokrem/.test(normalizeName(input.category ?? ""))
  )
    return "other_food";
  // Name rules take precedence over broad/mistranslated retailer categories.
  const rules: [Family, string][] = [
    ["baby_care", "pel(i|e)ni|diapers?|babylino|beb(i|y)lino"],
    ["baby_food", "kashichka|baby food|formula"],
    ["automotive", "avtostaklo|avtostalko|windscreen|windshield"],
    ["cleaning", "chistenje|mikrofiber|sredstvo za podovi|floor cleaner"],
    [
      "personal_care",
      "regenerator|shampon|deodorant|deo|pasta (?:za zabi|total)|toothpaste",
    ],
    ["clothing_accessories", "maica|shnola|hair clip|t shirt"],
    ["alcohol", "pivo|vino|uzo|ouzo|beer|wine|whisky|vodka"],
    ["dairy", "jogurt|yogurt|mleko|milk|pavlaka|sirenje|kashkaval"],
    ["soft_drinks", "coca cola|koka kola|pepsi|fanta|schweppes|sok|juice"],
    ["fruit", "jabolka|jabolko|krusha|krushi|banani|portokali|limoni"],
    ["vegetables", "domati|krastavici|kompir|morkov|piperki"],
    ["other_food", "leb|oriz|chokolado|bonboni|bread|rice|chocolate"],
  ];
  // Candy bearing a drink name must never become a drink.
  if (has(text, "bonboni|gumeni|haribo|candy")) return "other_food";
  const category = normalizeName(
    readableProductCategory(input.category ?? "", retailer),
  );
  const mapped = mappings.find(
    (mapping) =>
      mapping.retailer === retailer &&
      new RegExp(mapping.pattern, "iu").test(category) &&
      families.includes(mapping.family as Family),
  )?.family as Family | undefined;
  for (const [family, pattern] of rules)
    if (has(text, pattern)) {
      // Fruit words can be juice ingredients. A reviewed category or a printed
      // liquid amount prevents treating an apple drink as loose apples.
      if (["fruit", "vegetables", "other_food"].includes(family) && mapped)
        return mapped;
      if (
        ["fruit", "vegetables"].includes(family) &&
        /\d\s*(?:ml|мл|l|л)(?!\p{L})/iu.test(input.name)
      )
        return "unknown";
      return family;
    }
  for (const mapping of mappings)
    if (
      mapping.retailer === retailer &&
      new RegExp(mapping.pattern, "iu").test(category) &&
      families.includes(mapping.family as Family)
    )
      return mapping.family as Family;
  return "unknown";
}

export function prepareFacts(
  input: ProductInput,
  family: Family,
  rules: LocalMatchingRules,
): Facts {
  const facts: Facts = {};
  const readableName = readableProductText(input.name, input.retailer ?? "");
  const text = normalizeName(readableName.replace(/(?<=\p{L})[.!?]+/gu, " "));
  const put = (
    key: FactName,
    value: string,
    quote: string,
    source: Fact["source"] = "name",
  ) => {
    facts[key] = {
      value: canonicalFactValue(key, value, rules),
      quote,
      source,
      method: "rule",
    };
  };
  const matched = (pattern: RegExp) => input.name.match(pattern);
  const brands = rules.brands.filter(
    (brand) =>
      [brand.canonical, ...brand.aliases].some((alias) =>
        has(text, normalizeName(alias).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      ) &&
      !(
        brand.canonical === "coca-cola" &&
        has(text, "bonboni|haribo|gumeni|candy")
      ),
  );
  // Several brand names can describe a co-branded product or an ingredient.
  // Do not let the order of configuration entries silently choose one.
  if (brands.length === 1) put("brand", brands[0].canonical, input.name);
  const types: [string, string][] = [
    ["cola", "coca cola|koka kola|pepsi"],
    ["yogurt", "jogurt|yogurt"],
    ["milk", "mleko|milk"],
    ["cheese", "sirenje|kashkaval"],
    ["beer", "pivo|beer"],
    ["wine", "vino|wine"],
    ["ouzo", "uzo|ouzo"],
    ["diapers", "babylino|beb(i|y)lino|pel(i|e)ni|diapers?"],
    ["rice", "oriz|rice"],
    ["chocolate", "chokolado|dorina|chocolate"],
    ["candy", "bonboni|haribo|candy"],
    ["bread", "leb|bread"],
    ["apple", "jabolka|jabolko|apple"],
    ["pear", "krusha|krushi|pear"],
    ["tomato", "domati|tomato"],
    ["windscreen-fluid", "avtostaklo|avtostalko|windscreen|windshield"],
    ["hair-clip", "shnola|hair clip"],
    ["conditioner", "regenerator|conditioner"],
    ["shirt", "maica|t shirt"],
  ];
  for (const [type, pattern] of types)
    if (has(text, pattern)) {
      put("type", type, input.name);
      break;
    }
  if (has(text, "bonboni|haribo|candy")) put("type", "candy", input.name);
  const profile = productType(readableName);
  if (profile) put("type", profile.type, input.name);
  else if (
    family === "soft_drinks" &&
    /(?:^| )(?:sok|sokovi|juice|dzhus)(?: |$)/u.test(
      normalizeName(input.category ?? ""),
    )
  )
    put("type", "juice", input.category!, "category");
  else if (
    facts.brand?.value === "nutella" &&
    /kakao krem|eurokrem/.test(normalizeName(input.category ?? ""))
  )
    put("type", "spread", input.category!, "category");
  const variants: [string, string][] = [
    ["zero", "zero|zero sugar|zero shekjer"],
    ["original", "klasik|classic|original(?: taste)?"],
    ["summer", "letno|letna|summer"],
    ["winter", "zimsko|zimska|winter"],
    ["hazelnut", "leshnik|hazelnut"],
    ["dark", "temno|dark"],
    ["curly-hair", "curly hair"],
    ["coloured-hair", "coloured hair"],
    ["sensitive", "senzitiv|sensitiv|sensitive"],
  ];
  for (const [variant, pattern] of variants)
    if (has(text, pattern)) {
      // Hazelnut percentage is an ingredient declaration for this spread,
      // rather than a separate range. Other variant words remain significant.
      if (
        variant === "hazelnut" &&
        facts.brand?.value === "nutella" &&
        facts.type?.value === "spread"
      )
        continue;
      put("variant", variant, input.name);
      break;
    }
  const forms: [string, string][] = [
    ["can", "limenka|limenki|cans?"],
    ["plastic-bottle", "pet|plastic bottle"],
    ["glass-bottle", "staklo|stakleno|glass bottle"],
    ["carton", "tetrapak|tetra pak"],
  ];
  for (const [form, pattern] of forms)
    if (has(text, pattern)) {
      put("form", form, input.name);
      break;
    }
  const pack = packCount(input.name, input.retailer);
  if (pack) put("pack", String(pack.value), pack.quote);
  const amount = [
    ...input.name.matchAll(
      /(\d+(?:[.,]\d+)?)\s*(ml|мл|kg|кгр|кг|gr|гр|g|г|l|л)(?!\p{L})/giu,
    ),
  ];
  if (
    !["baby_care", "clothing_accessories", "household"].includes(family) &&
    amount.length === 1
  ) {
    const a = amount[0],
      n = a[1].replace(",", "."),
      unit = normalizeName(a[2]);
    const before = input.name.slice(0, a.index);
    if (
      new Decimal(n).gt(0) &&
      !/\d\s*[-–—]\s*$/.test(before) &&
      !(/^(ml|g|gr)$/.test(unit) && /^\d[.,]\d{3}$/.test(a[1]))
    ) {
      put(
        "quantity",
        new Decimal(n)
          .mul(["l", "kg", "kgr"].includes(unit) ? 1000 : 1)
          .toString(),
        a[0],
      );
      put("unit", ["ml", "l"].includes(unit) ? "ml" : "g", a[0]);
    }
  }
  const percent = matched(/\d+(?:[.,]\d+)?\s*%/u);
  if (percent && ["dairy", "alcohol"].includes(family))
    put(
      family === "dairy" ? "fat" : "alcohol",
      percent[0].replace(/\s|%/g, "").replace(",", "."),
      percent[0],
    );
  const size = matched(/(?:БР\.?|SIZE)\s*(\d+)/iu);
  if (size && family === "baby_care") put("size", size[1], size[0]);
  const model = matched(/\b([A-Z]+\d{3,}(?:\s+[A-Z]+\d+(?:-\d+)*)?)\b/iu);
  if (model && ["clothing_accessories", "household"].includes(family))
    put("model", model[1].toUpperCase().replace(/\s+/g, " "), model[0]);
  if (["fruit", "vegetables"].includes(family)) {
    const variety = matched(/(?:сорта\s*:\s*)([^,;]+)/iu);
    if (variety) put("variety", normalizeName(variety[1]), variety[0]);
    const grade = matched(/\d\s*[-–]?\s*(?:ра|ва|та)?\s*класа/iu);
    if (grade) put("grade", normalizeName(grade[0]), grade[0]);
    const origin = matched(/(?:потекло|origin)\s*:\s*([^,;]+)/iu);
    if (origin) put("origin", normalizeName(origin[1]), origin[0]);
    const loose = matched(/(?:\/|реф\.?)\s*(?:кгр?|kg)(?!\p{L})/iu);
    if (loose) put("sale_unit", "kg", loose[0]);
  }
  if (validGtin(input.gtin)) put("gtin", input.gtin!, input.gtin!, "gtin");
  Object.assign(facts, descriptiveFacts(input, facts, rules));
  return facts;
}

export function refreshProductFacts(
  product: StoreProduct,
  rules: LocalMatchingRules,
  mappings: CategoryMapping[],
): StoreProduct {
  const detected = familyFromText(product, product.retailer, mappings);
  const family =
    product.manual_family ??
    product.classified_family ??
    (detected === "unknown" ? product.family : detected);
  const facts: Facts = {};
  for (const key of factNames) {
    const fact = product.facts[key];
    if (
      fact?.method === "qwen" &&
      supportedFact(product, fact) &&
      (key !== "pack" ||
        packCount(fact.quote, product.retailer)?.value ===
          Number(fact.value)) &&
      (!["quantity", "unit"].includes(key) ||
        !["baby_care", "clothing_accessories", "household"].includes(family))
    )
      facts[key] = {
        ...fact,
        value: canonicalFactValue(key, fact.value, rules),
      };
  }
  Object.assign(facts, prepareFacts(product, family, rules));
  for (const key of factNames) {
    const value = product.manual_facts?.[key];
    if (value === null) delete facts[key];
    else if (value !== undefined)
      facts[key] = {
        value: canonicalFactValue(key, value, rules),
        quote: value,
        source: "manual",
        method: "manual",
      };
  }
  return {
    ...product,
    facts,
    family,
    local_key: localKey(
      readableProductText(product.name, product.retailer),
      facts,
      product.ambiguous,
      rules,
    ),
  };
}

export function localKey(
  name: string,
  facts: Facts,
  ambiguous: boolean,
  rules: LocalMatchingRules,
) {
  if (
    !ambiguous &&
    valueOf(facts, "type") === "eye-pencil" &&
    facts.brand &&
    facts.range &&
    facts.shade
  )
    return hash({
      version: rules.version,
      name: normalizeName(name),
      brand: facts.brand.value,
      range: facts.range.value,
      shade: facts.shade.value,
    });
  return localRuleKey(
    name,
    {
      brand: valueOf(facts, "brand"),
      variant: valueOf(facts, "variant"),
      quantity: valueOf(facts, "quantity"),
      unit: valueOf(facts, "unit") as "ml" | "g" | "piece" | null,
      pack: facts.pack ? Number(facts.pack.value) : null,
      form: valueOf(facts, "form"),
      gtin: valueOf(facts, "gtin"),
      ambiguous,
    },
    rules,
  );
}
export function differences(a: StoreProduct, b: StoreProduct): string[] {
  const output: string[] = [];
  // Categories guide search. A classification disagreement is not source proof
  // that two products differ; supported type/variant/amount facts decide that.
  for (const key of factNames) {
    const x = valueOf(a.facts, key),
      y = valueOf(b.facts, key);
    if (x !== null && y !== null && x !== y)
      output.push(`${key}: ${x} versus ${y}`);
  }
  return output;
}
export function evidenceGaps(a: StoreProduct, b: StoreProduct): string[] {
  if (a.ambiguous || b.ambiguous) return ["Source identity needs attention"];
  const conflicts = differences(a, b);
  if (conflicts.length) return conflicts;
  if (
    valueOf(a.facts, "gtin") &&
    valueOf(a.facts, "gtin") === valueOf(b.facts, "gtin")
  )
    return [];
  if (a.local_key && a.local_key === b.local_key) return [];
  if (["fruit", "vegetables"].includes(a.family))
    return a.family !== b.family
      ? ["Loose produce type is unclear"]
      : (["type", "variety", "sale_unit"] as FactName[])
          .filter(
            (k) => valueOf(a.facts, k) === null || valueOf(b.facts, k) === null,
          )
          .map((k) => `Missing ${factLabels[k]}`);
  const required: FactName[] = ["brand", "type"];
  if (valueOf(a.facts, "type") === "eye-pencil")
    required.push("range", "shade");
  else if (a.family === "baby_care") required.push("size", "pack", "variant");
  else if (a.family === "clothing_accessories" || a.family === "household")
    required.push("model");
  else required.push("quantity", "unit");
  const gaps = required
    .filter((k) => valueOf(a.facts, k) === null || valueOf(b.facts, k) === null)
    .map((k) => `Missing or unrecognized ${factLabels[k]}`);
  // One-sided distinguishing facts cannot be borrowed from another member.
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
  ] as FactName[])
    if (valueOf(a.facts, k) !== valueOf(b.facts, k))
      gaps.push(`Missing ${factLabels[k]} in one store`);
  if (
    ["soft_drinks", "dairy", "personal_care", "automotive", "pet"].includes(
      a.family,
    ) &&
    !valueOf(a.facts, "variant") &&
    !valueOf(a.facts, "fat") &&
    !valueOf(a.facts, "range") &&
    !valueOf(a.facts, "flavour") &&
    !valueOf(a.facts, "shade")
  )
    gaps.push("Missing distinguishing variant");
  return gaps;
}
export function enoughEvidence(a: StoreProduct, b: StoreProduct): boolean {
  return evidenceGaps(a, b).length === 0;
}
export function groupProblem(
  members: StoreProduct[],
  manuallyConfirmed: (a: string, b: string) => boolean = () => false,
): string | null {
  if (new Set(members.map((p) => p.retailer)).size !== members.length)
    return "Two distinct products from the same store would enter the group";
  if (
    members.some(
      (p) => p.ambiguous || p.branch_conflict || p.state === "legacy_conflict",
    )
  )
    return "Source identity or previous group needs attention";
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) {
      const conflict = differences(members[i], members[j]);
      if (conflict.length) return conflict.join("; ");
      const gaps = manuallyConfirmed(members[i].id, members[j].id)
        ? []
        : evidenceGaps(members[i], members[j]);
      if (gaps.length) return `Complete group: ${gaps.join("; ")}`;
    }
  return null;
}
export function requestProduct(p: StoreProduct) {
  const description =
    p.description === null
      ? null
      : readableProductText(p.description, p.retailer);
  const category =
    p.category === null
      ? null
      : readableProductCategory(p.category, p.retailer);
  const warnings = productTextWarnings(p.name, p.retailer);
  return {
    id: p.id,
    store: p.retailer,
    name: p.name,
    readable_name: readableProductText(p.name, p.retailer),
    description: p.description,
    category: p.category,
    ...(description !== null &&
    p.description !== null &&
    hasReadableTextChange(p.description, description)
      ? { readable_description: description }
      : {}),
    ...(category !== null &&
    p.category !== null &&
    hasReadableTextChange(p.category, category)
      ? { readable_category: category }
      : {}),
    ...(warnings.length ? { source_text_warnings: warnings } : {}),
    family: p.family,
    ...(Object.keys(p.manual_facts ?? {}).length
      ? { manual_details: p.manual_facts }
      : {}),
    facts: Object.fromEntries(
      Object.entries(p.facts).map(([key, fact]) => [key, fact.value]),
    ),
  };
}
export function supportedFact(input: ProductInput, fact: Fact): boolean {
  // Human corrections are authenticated separately; they must never be treated
  // as literal evidence supplied by a store or invented by a model.
  if (fact.source === "manual") return false;
  const text = input[fact.source];
  return (
    typeof text === "string" &&
    fact.quote.length > 0 &&
    text.includes(fact.quote)
  );
}
