import configuration from "@/config/default.json" with { type: "json" };
import language from "@/reference-data/product-language.json" with { type: "json" };
import brands from "@/reference-data/brands.json" with { type: "json" };
import type { LocalMatchingRules } from "@/nextsignal/domain/local-matching";

// Pure language-rule tests use the explicit starter dictionary. Application
// services resolve the current dictionary from PostgreSQL instead.
export const referenceMatchingRules: LocalMatchingRules = {
  ...configuration.matching.local,
  ...language,
  brands,
};
