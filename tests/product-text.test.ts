import { referenceMatchingRules } from "./helpers/reference-matching-rules";
import { expect, it } from "vitest";
import {
  readableProductCategory,
  readableProductText,
  productTextWarnings,
} from "@/nextsignal/domain/product-text";
import {
  inputFingerprint,
  requestProduct,
  prepareFacts,
  familyFromText,
  supportedFact,
  type StoreProduct,
} from "@/nextsignal/domain/matching";
import { normalizeName } from "@/nextsignal/domain/normalize";
import { settings } from "@/nextsignal/config";
import { expandNameSearch } from "@/nextsignal/domain/local-matching";
import { packCount } from "@/nextsignal/domain/pack-count";

it.each([
  ["spar", "2010 DETSKI SET ^E[EL I ^ETKA", "2010 ДЕТСКИ СЕТ ЧЕШЕЛ И ЧЕТКА"],
  ["spar", "SIREWE [OQA TENXERE YVEZDA", "СИРЕЊЕ ШОЉА ТЕНЏЕРЕ ЅВЕЗДА"],
  ["vero", "NO@ICI ZA KUTIKULI FE0104", "НОЖИЦИ ЗА КУТИКУЛИ FE0104"],
  ["dim", "СВЕ]НИК Д.МРАЗ 2СВЕ}И", "СВЕЌНИК Д.МРАЗ 2СВЕЌИ"],
  ["zur", "ЧАШИ ЗА `ЕСТОК ПИЈАЛАК", "ЧАШИ ЗА ЖЕСТОК ПИЈАЛАК"],
  [
    "ramstore",
    "КОСКА ЛОКУМ СО Ф`СТАЦИ 250 ГР",
    "КОСКА ЛОКУМ СО Ф'СТАЦИ 250 ГР",
  ],
  ["vero", "КРЕМА ЗА ГОТВЕЊЕ Д`ОРО 500МЛ", "КРЕМА ЗА ГОТВЕЊЕ Д'ОРО 500МЛ"],
  [
    "kam",
    "ЛИКЕР ОД БИЛКИ ИЛКЕНКОФ 200МЛ 35%АЛК",
    "ЛИКЕР ОД БИЛКИ ИЛКЕНКОФ 200МЛ 35%АЛК",
  ],
  [
    "kam",
    "FISHERMAN`S FRIEND БОНБОНИ ЦРЕША",
    "FISHERMAN'S FRIEND БОНБОНИ ЦРЕША",
  ],
  ["zito", "ТОРБА СО КОЦКИ 96ПАР.", "ТОРБА СО КОЦКИ 96ПАР."],
  [
    "stokomak",
    "СЛАДОЛЕД ВО КОРА ОД ЛИМОН 2Х150 МЛ",
    "СЛАДОЛЕД ВО КОРА ОД ЛИМОН 2Х150 МЛ",
  ],
  [
    "reptil",
    "Nivea Men Sensitive – Крема за бричење 100ml",
    "Nivea Men Sensitive – Крема за бричење 100ml",
  ],
])(
  "reads %s text without rewriting the source: %s",
  (store, original, readable) => {
    expect(readableProductText(original, store)).toBe(readable);
    expect(readableProductText(readable, store)).toBe(readable);
  },
);
it("preserves foreign brands, model codes, sizes, amounts, packs and ordinary punctuation", () => {
  for (const store of ["spar", "vero", "dim", "zur"]) {
    for (const original of [
      "WELLA Q10 SYOSS X5 XL XXL 38/1 4-9KG 330ML 24H24SM 10^3",
      "https://example.com/@shop name@example.com",
      "[6 pack] {set} | \\ ^ ~",
    ])
      expect(readableProductText(original, store)).toBe(original);
  }
  expect(readableProductText("[^AJ]", "spar")).toBe("[ЧАЈ]");
});
it("repairs a supplied control character and exposes unknown source characters without guessing", () => {
  expect(readableProductText("TE\u001e^EN SAPUN", "spar")).toBe("ТЕЧЕН САПУН");
  expect(readableProductText("ГИЛЕТЕ? БЛУ", "zur")).toBe("ГИЛЕТЕ? БЛУ");
  expect(productTextWarnings("ГИЛЕТЕ? БЛУ", "zur")).toHaveLength(1);
  expect(productTextWarnings("КНИГА ЗНАЕШ ЛИ МАМИЧКЕ?", "kam")).toEqual([]);
  expect(productTextWarnings("TE\u001e^EN", "spar")).toHaveLength(1);
  expect(productTextWarnings("Непознат\ufffd", "vero")[0]).toContain(
    "Do not guess",
  );
});
it("preserves SPAR English and Albanian categories independently of its name encoding", () => {
  expect(readableProductCategory("Cosmetic SET for Women", "spar")).toBe(
    "Cosmetic SET for Women",
  );
  expect(readableProductCategory("Te pa specifikuara", "spar")).toBe(
    "Te pa specifikuara",
  );
  expect(readableProductCategory("SIREWE KRAVJO VAKUM", "spar")).toBe(
    "СИРЕЊЕ КРАВЈО ВАКУМ",
  );
  expect(readableProductCategory("FILXANI SETOVI BORMIOLI", "spar")).toBe(
    "ФИЛЏАНИ SETOVI БОРМИОЛИ",
  );
});
function product(name: string, retailer: string): StoreProduct {
  const input = {
    name,
    retailer,
    description: null,
    category: null,
    gtin: null,
    ambiguous: false,
  };
  return {
    ...input,
    id: "test",
    external_key: "article",
    fingerprint: inputFingerprint(input),
    normalized_name: normalizeName(name),
    facts: {},
    family: "unknown",
    category_hints: [],
    local_key: null,
    group_id: "group",
    version: 1,
    state: "pending",
    last_reason: "new",
  };
}
it("uses readable names in both AI operations while keeping literal source evidence", () => {
  const p = {
    ...product("SIREWE KRAVJO 500GR", "spar"),
    description: "SIREWE",
    category: "[E]ER",
  };
  const before = inputFingerprint(p);
  const request = requestProduct(p);
  expect(request.name).toBe(p.name);
  expect(request.readable_name).toBe("СИРЕЊЕ КРАВЈО 500GR");
  expect(request.description).toBe("SIREWE");
  expect(request.readable_description).toBe("СИРЕЊЕ");
  expect(request.category).toBe("[E]ER");
  expect(request.readable_category).toBe("ШЕЌЕР");
  const family = familyFromText(p, "spar", settings.matching.category_mappings);
  expect(family).toBe("dairy");
  const facts = prepareFacts(p, family, referenceMatchingRules);
  expect(facts.type?.value).toBe("cheese");
  expect(facts.type?.quote).toBe(p.name);
  expect(supportedFact(p, facts.type!)).toBe(true);
  expect(
    supportedFact(p, { ...facts.type!, quote: request.readable_name }),
  ).toBe(false);
  expect(inputFingerprint(p)).toBe(before);
});
it("keeps unchanged KAM requests and source fingerprints reusable", () => {
  const p = product("МЛЕКО БИТОЛСКО 1Л", "kam");
  expect(requestProduct(p)).toEqual({
    id: p.id,
    store: "kam",
    name: p.name,
    readable_name: p.name,
    description: null,
    category: null,
    family: "unknown",
    facts: {},
  });
  expect(inputFingerprint(p)).toBe(
    inputFingerprint({ ...p, retailer: "another-store" }),
  );
});
it("does not invalidate categorization for formatting-only description cleanup", () => {
  const p = {
    ...product("БОНБОНИ ФИШЕРМЕН ЦРЕША 25ГР", "kam"),
    description: "FISHERMAN`S   FRIEND БОНБОНИ",
    category: "HAVANA      РУМ БЕЛ",
  };
  const request = requestProduct(p);
  expect(request).not.toHaveProperty("readable_description");
  expect(request).not.toHaveProperty("readable_category");
  expect(request.description).toBe(p.description);
  expect(request.category).toBe(p.category);
});
it("preserves Latin brand apostrophes in KAM descriptions", () => {
  expect(readableProductText("O`LYSEE ШАМПОН ЗА СУВО", "kam")).toBe(
    "O'LYSEE ШАМПОН ЗА СУВО",
  );
  expect(readableProductText("DOMA[NO ВРАТ СВИНСКИ", "kam")).toBe(
    "ДОМАШНО ВРАТ СВИНСКИ",
  );
});
it("separates explicit lower-case prepositions without splitting brands, models or URLs", () => {
  expect(readableProductText("KOSTIMzaKAPEWE", "spar")).toBe(
    "КОСТИМ за КАПЕЊЕ",
  );
  expect(readableProductText("GELzaTU[IRAWE", "spar")).toBe("ГЕЛ за ТУШИРАЊЕ");
  expect(
    readableProductText(
      "HappyDay ABzaCD123 https://example.com/GELzaTU[IRAWE",
      "spar",
    ),
  ).toBe("HappyDay ABzaCD123 https://example.com/GELzaTU[IRAWE");
});
it("supports searching for either original encoded spelling or readable spelling", () => {
  const encoded = expandNameSearch("SIREWE", referenceMatchingRules);
  expect(encoded).toContain("sirewe");
  expect(encoded).toContain("sirenje");
  expect(expandNameSearch("Ф`СТАЦИ", referenceMatchingRules)).toContain(
    "f staci",
  );
});
it("reads SPAR H multipacks only with an explicit mass/volume/piece unit and retains the source quote", () => {
  expect(packCount("PALMOLAJV GEL 2H250ML", "spar")).toEqual({
    value: 2,
    quote: "2H250ML",
  });
  expect(packCount("PALMOLAJV GEL 2H250ML", "kam")).toBeNull();
  expect(packCount("TORBA 24H24SM", "spar")).toBeNull();
  expect(packCount("MODEL QX-600H", "spar")).toBeNull();
  const p = product("PALMOLAJV TU[ GEL 2H250ML", "spar");
  const facts = prepareFacts(p, "personal_care", referenceMatchingRules);
  expect(facts.pack?.value).toBe("2");
  expect(facts.quantity?.value).toBe("250");
  expect(supportedFact(p, facts.pack!)).toBe(true);
});
