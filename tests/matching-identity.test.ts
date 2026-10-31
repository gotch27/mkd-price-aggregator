import { expect, it } from "vitest";
import catalogData from "@/prompts/matching-identity.json";
import { referenceMatchingRules as rules } from "./helpers/reference-matching-rules";
import {
  identityCatalogSchema,
  prepareIdentity,
  identityGaps,
  identityDifferences,
  unambiguousGroups,
  identityFields,
  identityInputKey,
} from "@/nextsignal/domain/matching-identity";
import {
  inputFingerprint,
  type StoreProduct,
  type Candidate,
} from "@/nextsignal/domain/matching";
import { normalizeName } from "@/nextsignal/domain/normalize";
import { validateClarification } from "@/nextsignal/domain/clarification";
const catalog = identityCatalogSchema.parse(catalogData);
function product(
  name: string,
  retailer = "kam",
  family: StoreProduct["family"] = "soft_drinks",
  category: string | null = null,
): StoreProduct {
  const source = {
    name,
    retailer,
    description: null,
    category,
    gtin: null,
    ambiguous: false,
  };
  return {
    ...source,
    id: retailer + name,
    external_key: name,
    fingerprint: inputFingerprint(source),
    normalized_name: normalizeName(name),
    facts: {},
    family,
    classified_family: family,
    category_hints: [],
    local_key: null,
    group_id: retailer + name,
    version: 1,
    state: "pending",
    last_reason: "test",
  };
}
const prepare = (p: StoreProduct) => prepareIdentity(p, rules, [], catalog);
it("recognizes water and its carbonation without an invented generic variant", () => {
  const a = product("ВОДА ХЕБА ГАЗИРАНА 1.5Л"),
    b = product("VODA HEBA 1.5L GAZIRANA", "spar");
  for (const p of [a, b])
    p.facts.brand = {
      value: "heba",
      source: "name",
      quote: p.name,
      method: "qwen",
    };
  const x = prepare(a),
    y = prepare(b);
  expect(x.facts.type?.value).toBe("water");
  expect(x.facts.carbonation?.value).toBe("sparkling");
  expect(identityGaps(x, y, catalog)).toEqual([]);
  expect(
    identityDifferences(
      x,
      prepare(product("VODA HEBA 1.5L NEGAZIRANA", "spar")),
      catalog,
    ),
  ).toContain("carbonation: sparkling versus still");
});
it("separates Fanta Shokata, Orange and Tropical instead of collapsing their fact maps", () => {
  const p = prepare(
    product(
      "СОК ФАНТА 1.75л ШОКАТА",
      "zito",
      "soft_drinks",
      "Останати газирани сокови",
    ),
  );
  for (const name of [
    "Fanta Tropical – Газиран сок 1.75l",
    "Fanta – Газиран сок со вкус портокал 1.75l",
  ]) {
    const other = prepare(product(name, "reptil"));
    expect(
      identityDifferences(p, other, catalog).some((r) =>
        r.startsWith("flavour:"),
      ),
    ).toBe(true);
  }
  expect(
    identityDifferences(
      p,
      prepare(product("Fanta Shokata – Газиран сок 1.75l", "reptil")),
      catalog,
    ),
  ).toEqual([]);
});
it("does not treat apple juice as an apple product", () => {
  const p = prepare(
    product(
      "ФРУКТАЛ ЈАБОЛКО 250МЛ ЛИМЕНКА",
      "zur",
      "soft_drinks",
      "Овошен сок",
    ),
  );
  expect(p.facts.type?.value).not.toBe("apple");
  expect(p.facts.flavour?.value).toBe("apple");
  const other = prepare(product("SOK FRUKTAL LIMENKA 250ML JABOLKO", "spar"));
  expect(identityDifferences(p, other, catalog)).not.toContain(
    "type: apple versus juice",
  );
});
it("does not turn an ingredient into a named flavour", () => {
  const p = product("Coca-Cola Original 330ml can");
  p.description =
    "Coca-Cola Original. Ingredients: water, cherry juice, lemon.";
  expect(prepare(p).facts.flavour).toBeUndefined();
});
it("recognizes source-supported protein drinks and the complete cookies-and-cream flavour", () => {
  const p = prepare(
    product("ПРОТЕИНСКИ НАПИТОК ЗОТТ КУКИС И КРЕМ 250МЛ", "vero", "dairy"),
  );
  expect(p.facts.type?.value).toBe("protein-drink");
  expect(p.facts.flavour?.value).toBe("cookies-and-cream");
  expect(p.identity?.statuses.type).toBe("known");
});
it("keeps explicit packs, fat percentages, Original/Zero and container differences", () => {
  for (const [a, b, family] of [
    ["Coca-Cola Original 330ml can", "Coca-Cola Zero 330ml can", "soft_drinks"],
    [
      "Coca-Cola Original 6 x 330ml cans",
      "Coca-Cola Original 330ml can",
      "soft_drinks",
    ],
    ["МЛЕКО 2.8% 1Л", "МЛЕКО 3.2% 1Л", "dairy"],
    [
      "Coca-Cola Original 330ml can",
      "Coca-Cola Original 330ml PET",
      "soft_drinks",
    ],
  ] as const) {
    const x = prepare(product(a, "kam", family)),
      y = prepare(product(b, "spar", family));
    expect(identityGaps(x, y, catalog).length).toBeGreaterThan(0);
  }
});
it("preserves manual nulls and keeps identity input keys stable across price/group/version changes", () => {
  const p = product("Coca-Cola Original 330ml can");
  p.manual_facts = { variant: null };
  const first = prepare(p);
  expect(first.facts.variant).toBeUndefined();
  const second = prepare({ ...p, version: 9, group_id: "new-group" });
  expect(second.identity?.key).toBe(first.identity?.key);
  expect(prepare({ ...p, name: p.name + " Zero" }).identity?.key).not.toBe(
    first.identity?.key,
  );
});
it("holds a competing store while allowing independent clear stores, regardless of order", () => {
  const q = prepare(product("Coca-Cola Original 330ml can"));
  const candidates = ["spar", "vero", "zito", "spar"].map((retailer, i) => {
    const p = prepare(product(`Coca-Cola Original 330ml can ${i}`, retailer));
    return {
      product: p,
      members: [p],
      group_version: 0,
      reasons: [],
      score: 1,
    } satisfies Candidate;
  });
  const result = unambiguousGroups(q, candidates);
  expect(result.accepted.map((c) => c.product.retailer).sort()).toEqual([
    "vero",
    "zito",
  ]);
  expect(unambiguousGroups(q, [...candidates].reverse()).held).toEqual(
    result.held,
  );
});
it("requests a relevant one-sided detail, without clearing a manual unknown or repeating complete drink fields", () => {
  const a = prepare(product("Coca-Cola Original 330ml can")),
    b = prepare(product("Coca-Cola Original 330ml", "spar"));
  expect(identityFields(a, catalog)).toEqual([]);
  expect(identityFields(b, catalog, [a])).toContain("form");
  b.manual_facts = { form: null };
  expect(identityFields(b, catalog, [a])).not.toContain("form");
  const care = prepare(product("ПАМПЕРС ПЕЛЕНИ 38/1", "vero", "baby_care"));
  expect(identityFields(care, catalog)).toContain("size");
});
it("prepares the source-reviewed Activia, Capri-Sun and Zott regression identities", () => {
  const cases = [
    [
      "АКТИВИА ОБРОК НАТУР 163Г",
      "AKTIVIA OBROK 163GR NATURAL",
      "dairy",
      "yogurt",
      "plain",
    ],
    [
      "ПИЈАЛАК КАПРИ САН МИСТИК ДРАГОН 0.2Л",
      "SOK^E KAPRI SAN 200ML MISTIK DRAGON",
      "soft_drinks",
      "soft-drink",
      "mystic-dragon",
    ],
    [
      "ЗОТТ ПРОТЕИНСКИ НАПИТОК КУКИС&КРЕМ 250МЛ",
      "PROTEIN NAPITOK 250ML ZOT KUKIS & KREM",
      "soft_drinks",
      "protein-drink",
      "cookies-and-cream",
    ],
  ] as const;
  for (const [left, right, family, type, flavour] of cases) {
    const a = product(left, "ramstore", family),
      b = product(right, "spar", family);
    for (const p of [a, b])
      p.facts.brand = {
        value:
          family === "dairy"
            ? "activia"
            : type === "protein-drink"
              ? "zott"
              : "capri-sun",
        source: "name",
        quote: p.name,
        method: "qwen",
      };
    const x = prepare(a),
      y = prepare(b);
    expect(Object.values(x.facts).map((f) => f.value)).toContain(flavour);
    expect(identityDifferences(x, y, catalog)).toEqual([]);
  }
});
it("preserves literal evidence and rejects generic source descriptions as containers", () => {
  const p = product("Zottis CHOKO 250ml negaziran sok");
  const result = validateClarification(
    p,
    [
      { field: "flavour", value: "CHOKO", quote: p.name, source: "name" },
      { field: "form", value: "negaziran sok", quote: p.name, source: "name" },
    ],
    ["flavour", "form"],
    rules,
    catalog,
  );
  expect(result.facts.flavour).toMatchObject({
    value: "chocolate",
    literal: "CHOKO",
    status: "known",
  });
  expect(result.facts.form).toBeUndefined();
  expect(result.rejected[0].reason).toContain("recognized value");
  expect(
    validateClarification(
      p,
      [{ field: "flavour", value: "chocolate", quote: p.name, source: "name" }],
      ["flavour"],
      rules,
      catalog,
    ).rejected[0].reason,
  ).toContain("exact source fragment");
});
it("preserves unknown text as uncertainty instead of an invented semantic conflict", () => {
  const a = product("Zottis chocolate 250ml", "kam", "dairy"),
    b = product("Zottis choko 250ml", "spar", "dairy");
  for (const p of [a, b])
    p.facts.flavour = {
      value: p === a ? "chocolate" : "choko",
      quote: p.name,
      source: "name",
      method: "qwen",
    };
  expect(
    identityDifferences(prepare(a), prepare(b), catalog).filter((v) =>
      v.startsWith("flavour:"),
    ),
  ).toEqual([]);
  b.facts.variant = {
    value: "Zottis choko",
    quote: b.name,
    source: "name",
    method: "qwen",
  };
  expect(prepare(b).facts.variant?.status).toBe("unrecognized");
  expect(
    identityGaps(prepare(a), prepare(b), catalog).some((v) =>
      v.startsWith("Unrecognized"),
    ),
  ).toBe(true);
});
it("blocks one-sided multivitamin milk and toast cheese formulations even with otherwise equal facts", () => {
  for (const [a, b] of [
    ["МЛЕКО АЛПСКО МУЛТИВИТ. 2.8% 1Л ТРАЈНО", "АЛПСКО!!! МЛЕКО 2.8% 1Л."],
    ["MEGLE 150GR EMENTALER", "МЕГЛЕ КАШКАВАЛ ТОСТ ЕМЕНТАЛЕР 150Г"],
  ]) {
    const left = product(a, "kam", "dairy"),
      right = product(b, "zur", "dairy");
    const x = prepare(left),
      y = prepare(right);
    expect(
      a.includes("МУЛТИВИТ") ? x.facts.variant?.value : y.facts.range?.value,
    ).toBe(a.includes("МУЛТИВИТ") ? "multivitamin" : "toast");
    expect(identityGaps(x, y, catalog).length).toBeGreaterThan(0);
  }
});
it("invalidates preparation only for dictionary aliases relevant to the actual product text", () => {
  const p = product("Heba water 1.5l sparkling");
  const first = identityInputKey(p, catalog, rules);
  expect(
    identityInputKey(p, catalog, {
      ...rules,
      brands: [
        ...rules.brands,
        { canonical: "unrelated", aliases: ["unrelated brand"] },
      ],
    }),
  ).toBe(first);
  expect(
    identityInputKey(p, catalog, {
      ...rules,
      brands: [...rules.brands, { canonical: "heba", aliases: ["heba"] }],
    }),
  ).not.toBe(first);
});
