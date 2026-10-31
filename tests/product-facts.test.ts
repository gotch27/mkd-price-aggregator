import { identityCatalog } from "@/nextsignal/services/identity-catalog";
import { referenceMatchingRules } from "./helpers/reference-matching-rules";
import { expect, it } from "vitest";
import { settings } from "@/nextsignal/config";
import { validateClarification } from "@/nextsignal/domain/clarification";
import { canonicalBrand } from "@/nextsignal/domain/product-facts";
import { hasLengthDimensions } from "@/nextsignal/domain/pack-count";
import {
  differences,
  evidenceGaps,
  familyFromText,
  groupProblem,
  inputFingerprint,
  localKey,
  prepareFacts,
  refreshProductFacts,
  type ProductInput,
  type StoreProduct,
} from "@/nextsignal/domain/matching";
import { normalizeName } from "@/nextsignal/domain/normalize";

function product(name: string, retailer = "kam"): StoreProduct {
  const input: ProductInput = {
    name,
    description: null,
    category: null,
    gtin: null,
    ambiguous: false,
  };
  const family = familyFromText(
    input,
    retailer,
    settings.matching.category_mappings,
  );
  const facts = prepareFacts(input, family, referenceMatchingRules);
  return {
    ...input,
    id: retailer,
    retailer,
    external_key: name,
    fingerprint: inputFingerprint(input),
    normalized_name: normalizeName(name),
    family,
    facts,
    local_key: localKey(name, facts, false, referenceMatchingRules),
    category_hints: [],
    group_id: retailer,
    version: 1,
    state: "pending",
    last_reason: "New",
  };
}

it("compares reviewed brand spellings while preserving original evidence", () => {
  for (const value of ["НУТЕЛА", "Nutela", "Nutella"])
    expect(canonicalBrand(value, referenceMatchingRules)).toBe("nutella");
  const p = product("КРЕМ НУТЕЛА 400ГР");
  expect(p.facts.brand?.value).toBe("nutella");
  expect(p.facts.brand?.quote).toBe(p.name);
  expect(canonicalBrand("Bambi", referenceMatchingRules)).not.toBe("plazma");
});

it("keeps product type separate from range and rejects different ranges", () => {
  const care = product("Nivea shower gel Creme Care 250 ml");
  const soft = product("NIVEA ГЕЛ ЗА ТУШИРАЊЕ КРЕМ СОФТ 250МЛ", "vero");
  const generic = product("Nivea shower gel 250 ml", "spar");
  expect(care.facts.type?.value).toBe("shower-gel");
  expect(soft.facts.type?.value).toBe("shower-gel");
  expect(differences(care, soft)).toContain(
    "range: creme care versus creme soft",
  );
  expect(evidenceGaps(care, generic)).toContain(
    "Missing product range in one store",
  );
  expect(groupProblem([care, soft])).toContain("range");
});

it("reads fragrance after the cleaning product type instead of calling it fruit", () => {
  const p = product("FAIRY APPLE dishwashing liquid 900 ml");
  expect(p.family).toBe("cleaning");
  expect(p.facts.type?.value).toBe("dishwashing-liquid");
  expect(p.facts.flavour?.value).toBe("apple");
  const q = product("FERI LIMON 900ML", "spar");
  expect(differences(p, q)).toContain("flavour: apple versus lemon");
});

it("separates ground biscuits, produce grade, coffee containers and cosmetic shades", () => {
  expect(
    differences(
      product("Plazma biskviti meleni 300g"),
      product("Plazma biskviti celi 300g", "spar"),
    ),
  ).toContain("processing: ground versus whole");
  const a = product("Garden Extra kornishoni 6-9 cm 720g");
  const b = product("Garden Extra kornishoni 3-6 cm 720g", "spar");
  expect(a.family).toBe("other_food");
  expect(differences(a, b).some((x) => x.startsWith("grade:"))).toBe(true);
  expect(
    differences(
      product("Nescafe Classic 200g tin"),
      product("Nescafe Classic 200g glass jar", "spar"),
    ),
  ).toContain("form: can versus glass jar");
  expect(
    differences(
      product("Malena Pink moliv 707"),
      product("Malena Pink moliv 701", "spar"),
    ),
  ).toContain("shade: 707 versus 701");
});

it("does not remove unknown variants or model codes from exact signatures", () => {
  const a = product("Milka dark 100g");
  const b = product("Milka dark caramel 100g", "spar");
  expect(a.local_key).not.toBe(b.local_key);
  expect(product("Plazma Mini 200g").local_key).not.toBe(
    product("Plazma Mini Mini 200g").local_key,
  );
  expect(
    product("Nivea shower gel Creme Soft 250ml 550097").local_key,
  ).not.toBe(product("Nivea shower gel Creme Soft 250ml").local_key);
});

it("normalizes full phrases before shorter overlapping aliases", () => {
  const a = product("Nivea gel za tushiranje krem ker 250ml");
  const b = product("Nivea gel za tushiranje krem kear 250ml", "spar");
  expect(a.local_key).not.toBeNull();
  expect(a.local_key).toBe(b.local_key);
});

it("retains good clarification fields when another field is unsupported", () => {
  const p = product("НУТЕЛА C9834 400 g");
  const result = validateClarification(
    p,
    [
      { field: "brand", value: "НУТЕЛА", quote: "НУТЕЛА", source: "name" },
      { field: "model", value: "C9835", quote: "C9834", source: "name" },
    ],
    ["brand", "model"],
    referenceMatchingRules,
    identityCatalog,
  );
  expect(result.facts.brand?.value).toBe("nutella");
  expect(result.facts.brand?.quote).toBe("НУТЕЛА");
  expect(result.facts.model).toBeUndefined();
  expect(result.rejected.map((x) => x.field)).toEqual(["model"]);
});

it("validates amount and unit atomically without discarding unrelated good evidence", () => {
  const p = product("Nutella 0,4 kg");
  const valid = [
    {
      field: "brand" as const,
      value: "Nutella",
      quote: "Nutella",
      source: "name" as const,
    },
    {
      field: "quantity" as const,
      value: "0,4",
      quote: "0,4 kg",
      source: "name" as const,
    },
    {
      field: "unit" as const,
      value: "kg",
      quote: "0,4 kg",
      source: "name" as const,
    },
  ];
  const result = validateClarification(
    p,
    valid,
    ["brand", "quantity", "unit"],
    referenceMatchingRules,
    identityCatalog,
  );
  expect(result.facts.quantity?.value).toBe("400");
  expect(result.facts.unit?.value).toBe("g");
  const invalid = validateClarification(
    p,
    [...valid.slice(0, 2), { ...valid[2], value: "l" }],
    ["brand", "quantity", "unit"],
    referenceMatchingRules,
    identityCatalog,
  );
  expect(Object.keys(invalid.facts)).toEqual(["brand"]);
});

it("rejects duplicate facts, invented counts and borrowed or translated quotes", () => {
  const p = product("BABYLINO SIZE 6 13-18KG 12/1");
  const result = validateClarification(
    p,
    [
      { field: "pack", value: "2", quote: "12/1", source: "name" },
      { field: "brand", value: "BABYLINO", quote: "BABYLINO", source: "name" },
      { field: "brand", value: "Other", quote: "BABYLINO", source: "name" },
      {
        field: "variant",
        value: "sensitive",
        quote: "SENSITIVE",
        source: "name",
      },
    ],
    ["brand", "pack", "variant"],
    referenceMatchingRules,
    identityCatalog,
  );
  expect(result.facts).toEqual({});
});

it("refreshes old supported AI brand values without manufacturing missing facts", () => {
  const p = product("NUTELA 400g");
  p.facts.brand = {
    value: "нутела",
    quote: "NUTELA",
    source: "name",
    method: "qwen",
  };
  p.facts.type = {
    value: "еурокрем",
    quote: "Not in this source",
    source: "name",
    method: "qwen",
  };
  const refreshed = refreshProductFacts(
    p,
    referenceMatchingRules,
    settings.matching.category_mappings,
  );
  expect(refreshed.facts.brand?.value).toBe("nutella");
  expect(refreshed.facts.type).toBeUndefined();
  expect(refreshed.name).toBe(p.name);
  expect(refreshed.fingerprint).toBe(p.fingerprint);
});

it("recognizes product nouns before ingredients and preserves explicit flavours", () => {
  const food = product("ХРАНА ЗА КУЧЕ ХИТ МИНИ ПИЛЕ-ОРИЗ 500ГР.", "vero");
  expect(food.family).toBe("pet");
  expect(food.facts.type?.value).toBe("dog-food");
  expect(food.facts.brand?.value).toBe("hit");
  expect(food.facts.flavour?.value).toBe("chicken rice");
  expect(product("ДР БЕННЕР ГРАНОЛА ЈАГОДА 40ГР.").facts.type?.value).toBe(
    "granola",
  );
  expect(product("КУПКА КОСИЛИ РОЗЕ 200МЛ").family).toBe("personal_care");
  expect(
    product("НАПОЛИТАНКИ ШТАРК КАКАО И ВАНИЛА 130ГР").facts.type?.value,
  ).toBe("wafer");
  expect(product("ВИВА ЛАДЕН ЧАЈ ПРАСКА 1.5Л").family).toBe("soft_drinks");
});
it("manual confirmation can establish missing facts but never bypass a known conflict", () => {
  const a = product("Example chocolate 100 g"),
    b = product("Example chocolate 100 g", "vero");
  expect(groupProblem([a, b])).not.toBeNull();
  expect(groupProblem([a, b], () => true)).toBeNull();
  expect(
    groupProblem([a, product("Example chocolate 200 g", "vero")], () => true),
  ).not.toBeNull();
});

it("uses reviewed juice categories before fruit ingredients and leaves unlabelled liquid products unclear", () => {
  const input = {
    name: "ВОЧНА ДОЛИНА КАЈСИЈА/ЈАБОЛКО 1,5Л.",
    description: null,
    category: "БЕЗАЛКОХОЛНИ ПИЈАЛОЦИ - ЏУС",
    gtin: null,
    ambiguous: false,
  };
  expect(
    familyFromText(input, "vero", settings.matching.category_mappings),
  ).toBe("soft_drinks");
  expect(
    prepareFacts(input, "soft_drinks", referenceMatchingRules).type?.value,
  ).toBe("juice");
  expect(
    familyFromText(
      { ...input, category: null },
      "zur",
      settings.matching.category_mappings,
    ),
  ).toBe("unknown");
  expect(product("СОК КОКА КОЛА ЗЕРО ЛИМЕНКА 0.33Л").facts.type?.value).toBe(
    "cola",
  );
});

it.each([
  "МОДЛИ ЗА МАФИНИ 35Х26ЦМ",
  "Tray 35x26cm",
  "Tray 35 × 26 cm",
  "Tray 350*260 мм",
  "Мат 0,35х0,26м",
  "Sheet 0.35 x 0.26 m",
  "Box 35x26x12cm",
])("does not turn product dimensions into a pack count: %s", (name) => {
  expect(product(name).facts.pack).toBeUndefined();
  expect(hasLengthDimensions(name)).toBe(true);
});

it.each([
  ["Milk 2x500ml", "2", "500", "ml", "2x500ml"],
  ["МЛЕКО 2Х0,5Л.", "2", "500", "ml", "2Х0,5Л"],
  ["Milk 500 ml × 2", "2", "500", "ml", "500 ml × 2"],
  ["Chocolate 6 * 0.1 kg", "6", "100", "g", "6 * 0.1 kg"],
])(
  "keeps supported pack counts separate from per-item amount: %s",
  (name, pack, quantity, unit, quote) => {
    const facts = product(name).facts;
    expect(facts.pack).toMatchObject({ value: pack, quote });
    expect(facts.quantity?.value).toBe(quantity);
    expect(facts.unit?.value).toBe(unit);
    expect(hasLengthDimensions(name)).toBe(false);
  },
);

it("reads diaper counts without turning the baby's weight into package quantity", () => {
  const facts = product("BABYLINO SENSITIVE SIZE 6 13-18KG 38/1").facts;
  expect(facts.pack).toMatchObject({ value: "38", quote: "38/1" });
  expect(facts.size?.value).toBe("6");
  expect(facts.quantity).toBeUndefined();
  expect(facts.unit).toBeUndefined();
  expect(
    product("BABYLINO SENSITIVE SIZE 6 13-18KG 38/10").facts.pack,
  ).toBeUndefined();
});

it("leaves household vessel capacity out of the sellable product quantity", () => {
  const input = {
    name: "Cooking pot 5L 2 pieces",
    description: null,
    category: "Household",
    gtin: null,
    ambiguous: false,
  };
  const facts = prepareFacts(input, "household", referenceMatchingRules);
  expect(facts.pack?.value).toBe("2");
  expect(facts.quantity).toBeUndefined();
  expect(facts.unit).toBeUndefined();
});

it.each(["rule", "qwen"] as const)(
  "drops an old incorrect %s dimension-derived pack when source facts are refreshed",
  (method) => {
    const p = product("МОДЛИ ЗА МАФИНИ 35Х26ЦМ");
    p.facts.pack = { value: "35", quote: "35Х2", source: "name", method };
    expect(
      refreshProductFacts(
        p,
        referenceMatchingRules,
        settings.matching.category_mappings,
      ).facts.pack,
    ).toBeUndefined();
  },
);

it("rejects AI pack guesses based only on a number in product dimensions", () => {
  const p = product("МОДЛИ ЗА МАФИНИ 35Х26ЦМ");
  const result = validateClarification(
    p,
    [{ field: "pack", value: "35", quote: "35Х26ЦМ", source: "name" }],
    ["pack"],
    referenceMatchingRules,
    identityCatalog,
  );
  expect(result.facts.pack).toBeUndefined();
  expect(result.rejected[0].reason).toContain("explicit count");
  const diapers = product("BABYLINO SIZE 6 13-18KG 38/1");
  expect(
    validateClarification(
      diapers,
      [{ field: "pack", value: "38", quote: "38/1", source: "name" }],
      ["pack"],
      referenceMatchingRules,
      identityCatalog,
    ).facts.pack?.value,
  ).toBe("38");
});

it.each([
  ["BABYLINO SIZE 6 13-18KG 38/1", "baby_care", "18", "KG", "13-18KG"],
  ["Cooking pot 5L 2 pieces", "household", "5", "L", "5L"],
  ["Example 13-18KG", "unknown", "18", "KG", "13-18KG"],
] as const)(
  "does not let AI turn a range or vessel capacity into product quantity: %s",
  (name, family, quantity, unit, quote) => {
    const result = validateClarification(
      { ...product(name), family },
      [
        { field: "quantity", value: quantity, quote, source: "name" },
        { field: "unit", value: unit, quote, source: "name" },
      ],
      ["quantity", "unit"],
      referenceMatchingRules,
      identityCatalog,
    );
    expect(result.facts.quantity).toBeUndefined();
    expect(result.facts.unit).toBeUndefined();
  },
);
