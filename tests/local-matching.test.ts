import { expect, it } from "vitest";
import { referenceMatchingRules } from "./helpers/reference-matching-rules";
import {
  localRuleKey,
  expandNameSearch,
} from "@/nextsignal/domain/local-matching";
import { attributes } from "@/nextsignal/domain/normalize";
const rules = referenceMatchingRules;
const key = (name: string) =>
  localRuleKey(name, attributes({ name, category: null, gtin: null }), rules);
it("searches configured brand spellings without dropping variant words", () => {
  expect(expandNameSearch("coca", rules)).toContain("koka kola");
  expect(expandNameSearch("coca cola zero", rules)).toContain("koka kola zero");
  expect(expandNameSearch("milk", rules)).toEqual(["milk"]);
});
it("joins transliterated reordered names and equivalent units using only local rules", () => {
  expect(key("СОК КОКА КОЛА ЗЕРО ЛИМЕНКА 0.33Л")).not.toBeNull();
  expect(key("СОК КОКА КОЛА ЗЕРО ЛИМЕНКА 0.33Л")).toBe(
    key("Coca Cola Can Zero 330ml"),
  );
});
it("keeps quantity, variant, flavor, package and multipack conflicts separate", () => {
  for (const [a, b] of [
    ["Pepsi Zero Can 330ml", "Pepsi Classic Can 330ml"],
    ["Pepsi Can 330ml", "Pepsi Can 500ml"],
    ["Pepsi Can 330ml", "Pepsi PET 330ml"],
    ["Pepsi Can 6x330ml", "Pepsi Can 330ml"],
    ["Milka Leshnik 100g", "Milka Jagoda 100g"],
    ["Alpsko Mleko 2.8% 1L", "Alpsko Mleko 1.5% 1L"],
    ["Pepsi Zero Can 330ml", "Pepsi Can 330ml"],
  ])
    expect(key(a)).not.toBe(key(b));
});
it("abstains on missing brands, ambiguous quantities and multiple named brands", () => {
  expect(key("МЛЕКО 1Л")).toBeNull();
  expect(key("Podravka 100g")).toBeNull();
  expect(key("КОКА КОЛА 1.750МЛ")).toBeNull();
  expect(key("Milka Nestle 100g")).toBeNull();
  expect(key("*")).toBeNull();
});
it("does not turn sweets into drinks or infer missing package information", () => {
  expect(key("Coca Cola Gummy 200g")).not.toBe(key("Coca Cola 200ml"));
  expect(key("Coca Cola Can 330ml")).not.toBe(key("Coca Cola 330ml"));
});

it("uses the same exact rule key for legacy symbols, Latin diacritics, and Cyrillic", () => {
  const expected = key("MILKA ЛЕШНИК 100Г");
  expect(expected).not.toBeNull();
  expect(key("MILKA LE[NIK 100G")).toBe(expected);
  expect(key("MILKA LE{NIK 100G")).toBe(expected);
  expect(key("MILKA LEŠNIK 100G")).toBe(expected);
  expect(key("MILKA LE[NIK 200G")).not.toBe(expected);
  expect(key("MILKA JAGODA 100G")).not.toBe(expected);
  expect(expandNameSearch("^E[EL", rules)).toEqual(["cheshel"]);
  expect(expandNameSearch("ЧЕШЕЛ", rules)).toEqual(["cheshel"]);
});
