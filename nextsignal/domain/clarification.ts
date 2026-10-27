import Decimal from "decimal.js";
import { normalizeName } from "@/nextsignal/domain/normalize";
import { canonicalFactValue } from "@/nextsignal/domain/product-facts";
import { packCount } from "@/nextsignal/domain/pack-count";
import {
  factNames,
  familyFromText,
  supportedFact,
  type Fact,
  type FactName,
  type Facts,
  type Family,
  type ProductInput,
} from "@/nextsignal/domain/matching";
import type { LocalMatchingRules } from "@/nextsignal/domain/local-matching";

type ExtractedFact = {
  field: FactName;
  value: string;
  quote: string;
  source: Exclude<Fact["source"], "manual">;
};
export function validateClarification(
  product: ProductInput & { family?: Family },
  entries: ExtractedFact[],
  allowed: readonly string[],
  rules: LocalMatchingRules,
) {
  const facts: Facts = {},
    rejected: { field: FactName; reason: string }[] = [];
  const duplicates = new Set(
    entries
      .filter(
        (entry, i) => entries.findIndex((e) => e.field === entry.field) !== i,
      )
      .map((e) => e.field),
  );
  const reject = (field: FactName, reason: string) => {
    delete facts[field];
    rejected.push({ field, reason });
  };
  for (const entry of entries) {
    const fact: Fact = {
      value: entry.value,
      quote: entry.quote,
      source: entry.source,
      method: "qwen",
    };
    if (
      !factNames.includes(entry.field) ||
      !allowed.includes(entry.field) ||
      duplicates.has(entry.field)
    ) {
      reject(
        entry.field,
        "Clarification contains an unrequested or repeated field",
      );
      continue;
    }
    if (!supportedFact(product, fact)) {
      reject(entry.field, "Clarification contains unsupported evidence");
      continue;
    }
    if (["quantity", "pack", "fat", "alcohol", "size"].includes(entry.field)) {
      if (
        !/^\d+(?:[.,]\d+)?$/.test(entry.value) ||
        ![...entry.quote.matchAll(/\d+(?:[.,]\d+)?/g)].some((m) =>
          new Decimal(m[0].replace(",", ".")).eq(entry.value.replace(",", ".")),
        )
      ) {
        reject(entry.field, "Clarification numeric evidence is invalid");
        continue;
      }
      fact.value = new Decimal(entry.value.replace(",", ".")).toString();
      if (
        entry.field === "pack" &&
        packCount(entry.quote, product.retailer)?.value !== Number(fact.value)
      ) {
        reject("pack", "Pack evidence does not establish an explicit count");
        continue;
      }
      if (
        (["quantity", "pack"].includes(entry.field) &&
          new Decimal(fact.value).lte(0)) ||
        (entry.field === "pack" && !new Decimal(fact.value).isInteger())
      ) {
        reject(
          entry.field,
          "Quantity and pack counts must be positive; pack counts must be integers",
        );
        continue;
      }
    } else {
      const literal = normalizeName(entry.value).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      if (
        !new RegExp(
          `(?:^|[^\\p{L}\\p{N}])${literal}(?=$|[^\\p{L}\\p{N}])`,
          "u",
        ).test(normalizeName(entry.quote))
      ) {
        reject(
          entry.field,
          "Clarification value is not present in its supporting quote",
        );
        continue;
      }
      fact.value = canonicalFactValue(entry.field, entry.value, rules);
    }
    facts[entry.field] = fact;
  }
  // An amount and its unit are one piece of evidence. Keep neither if one
  // failed, or if they describe separate numbers/fields in the source.
  if (facts.quantity || facts.unit) {
    const quantity = facts.quantity,
      unit = facts.unit;
    const amounts =
      quantity && quantity.source !== "manual"
        ? [
            ...(product[quantity.source] ?? "").matchAll(
              /(\d+(?:[.,]\d+)?)\s*(ml|мл|kg|кгр|кг|gr|гр|g|г|l|л)(?!\p{L})/giu,
            ),
          ]
        : [];
    const family = product.family ?? familyFromText(product, "", []);
    const beforeAmount =
      quantity && quantity.source !== "manual" && amounts.length === 1
        ? (product[quantity.source] ?? "").slice(0, amounts[0].index)
        : "";
    if (
      !quantity ||
      !unit ||
      quantity.source !== unit.source ||
      amounts.length !== 1 ||
      ["baby_care", "clothing_accessories", "household"].includes(family) ||
      /\d\s*[-–—]\s*$/.test(beforeAmount) ||
      !["g", "gr", "kg", "ml", "l"].includes(unit.value) ||
      !new Decimal(amounts[0][1].replace(",", ".")).eq(quantity.value) ||
      canonicalFactValue("unit", amounts[0][2], rules) !== unit.value ||
      (["ml", "g", "gr"].includes(unit.value) &&
        /^\d[.,]\d{3}$/.test(amounts[0][1]))
    ) {
      reject(
        "quantity",
        "Quantity and unit do not describe one explicit source amount",
      );
      reject(
        "unit",
        "Quantity and unit do not describe one explicit source amount",
      );
    } else {
      quantity.value = new Decimal(quantity.value)
        .mul(["kg", "l"].includes(unit.value) ? 1000 : 1)
        .toString();
      unit.value = ["kg", "g", "gr"].includes(unit.value) ? "g" : "ml";
    }
  }
  return { facts, rejected };
}
