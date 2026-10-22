import { it, expect } from "vitest";
import {
  attributes,
  conflicts,
  normalizeName,
  validGtin,
  money,
  identity,
  canonicalAttributes,
} from "@/nextsignal/domain/normalize";
import type { CatalogRow } from "@/nextsignal/domain/types";
const a = (name: string) => attributes({ name, category: null, gtin: null });
it("normalizes script and size variants", () => {
  expect(a("КОКА КОЛА ЛИМЕНКА 0.33Л").quantity).toBe("330");
  expect(a("СОК КОКА КОЛА 330мл ЛИМЕНКА").quantity).toBe("330");
  expect(normalizeName("КОКА КОЛА")).toBe("koka kola");
});
it("keeps absent identity fields unknown", () =>
  expect(a("КОКА КОЛА 330мл")).toMatchObject({ variant: null, form: null }));
it("canonicalizes provider attributes without filling absent fields", () => {
  expect(
    canonicalAttributes({
      ...a("330мл"),
      brand: "КОКА КОЛА",
      variant: "ЗЕРО",
      form: "лименка",
    }),
  ).toMatchObject({
    brand: "coca-cola",
    variant: "zero",
    form: "can",
    pack: null,
  });
});
it("rejects pack, variant, quantity and form conflicts", () => {
  expect(
    conflicts(a("КОКА КОЛА КЛАСИК 330мл"), a("КОКА КОЛА ЗЕРО 330мл")),
  ).toBe(true);
  expect(conflicts(a("КОКА КОЛА 1Х330мл"), a("КОКА КОЛА 6Х330мл"))).toBe(true);
  expect(conflicts(a("КОКА КОЛА 1.25Л"), a("КОКА КОЛА 330мл"))).toBe(true);
  expect(
    conflicts(a("КОКА КОЛА 330мл ЛИМЕНКА"), a("КОКА КОЛА 330мл ПЕТ")),
  ).toBe(true);
});
it("does not attach drinks to sweets", () =>
  expect(
    conflicts(a("КОКА КОЛА 330МЛ"), a("МИНИЦЦО ГУМЕНИ КОКА КОЛА 200Г")),
  ).toBe(true));
it("flags ambiguous source quantities", () =>
  expect(a("КОКА КОЛА 1.750МЛ").ambiguous).toBe(true));
it("does not interpret a diaper weight range as the product's net quantity", () => {
  expect(a("ПЕЛЕНИ 3-6кг 60/1").ambiguous).toBe(true);
  expect(a("DIAPERS 3–6kg 60/1").ambiguous).toBe(true);
});
it("validates barcodes rather than retailer article codes", () => {
  expect(validGtin("4006381333931")).toBe(true);
  expect(validGtin("4006381333932")).toBe(false);
  expect(validGtin("015476")).toBe(false);
  expect(validGtin("0000000000000")).toBe(false);
});
it("handles prices without binary floating point", () => {
  expect(money("1.234,50 ден.")).toBe("1234.50");
  expect(money("0.10")).toBe("0.10");
  expect(money("1.199ден.")).toBe("1199.00");
  expect(money("65 денари")).toBe("65.00");
  expect(money("1.199,99 денари")).toBe("1199.99");
  expect(money("-")).toBeNull();
  expect(money("0.001")).toBeNull();
});
it("identity excludes changing offers", () => {
  const row = {
    name: "МЛЕКО 1Л",
    description: "млеко",
    category: "млеко",
    gtin: null,
    price: "65.00",
  } as CatalogRow;
  expect(identity(row)).toBe(
    identity({ ...row, price: "80.00", available: false }),
  );
});

it("preserves source wall-clock seconds and configured timezone", async () => {
  const { sourceTimestamp } = await import("@/nextsignal/domain/source-time");
  expect(
    sourceTimestamp(
      "Датум и време на последно ажурирање: 20.10.2026 6:10:06AM",
      "Europe/Skopje",
    ),
  ).toBe("2026-10-20T04:10:06.000Z");
});

it.each([
  ["2010 DETSKI SET ^E[EL I ^ETKA", "2010 ДЕТСКИ СЕТ ЧЕШЕЛ И ЧЕТКА"],
  ["^A[A MRE@A", "ЧАША МРЕЖА"],
  ["^AJ \\UMBIR 40GR", "ЧАЈ ЃУМБИР 40ГР"],
  ["ВРЕ]И ЗА |УБРЕ", "ВРЕЌИ ЗА ЃУБРЕ"],
  ["ВЛА`НИ МАРАМИЦИ", "ВЛАЖНИ МАРАМИЦИ"],
  ["ВАНИЛИН ШЕ}ЕР 10Г", "ВАНИЛИН ШЕЌЕР 10Г"],
  ["[E]ER", "ШЕЌЕР"],
  ["ve{ta~ko cve}e", "вештачко цвеќе"],
  ["Milka Lešnik 100g", "Milka Лешник 100g"],
  ["ČAJ ǴUMBIR ŽITO ḰESE", "ЧАЈ ЃУМБИР ЖИТО ЌЕСЕ"],
  ["SHE\u007dER", "SHEЌER"],
])(
  "normalizes legacy and Unicode spellings identically: %s",
  (legacy, unicode) => {
    expect(normalizeName(legacy)).toBe(normalizeName(unicode));
    expect(normalizeName(normalizeName(legacy))).toBe(normalizeName(legacy));
  },
);
it("keeps packaging punctuation and Latin brand/model letters distinct from legacy glyphs", () => {
  expect(normalizeName("SHAMPOO [PACK] {SET} 10^3 100ML")).toBe(
    "shampoo pack set 10 3 100ml",
  );
  expect(normalizeName("NIVEA Q10 WELLA SYOSS X5")).toBe(
    "nivea q10 wella syoss x5",
  );
  expect(normalizeName("[ ] ^ ~ @ \\ | { } `")).toBe("");
  expect(normalizeName("MILKA LE[NIK 100G")).not.toBe(
    normalizeName("MILKA LENIK 100G"),
  );
});
it("does not interpret email addresses and URLs as legacy product spelling", async () => {
  const { decodeLegacyMacedonian } =
    await import("@/nextsignal/domain/name-encoding");
  expect(
    decodeLegacyMacedonian(
      "Contact name@example.com https://example.com/@shop",
    ),
  ).toBe("Contact name@example.com https://example.com/@shop");
  expect(normalizeName("[^AJ]")).toBe("chaj");
});
