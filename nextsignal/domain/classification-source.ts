import type { StoreProduct } from "./matching";

// Classification freshness follows source information and classifier prompts,
// rather than the evolving brand dictionary or matching-only preparation.
export function classificationSource(p: StoreProduct) {
  return {
    retailer: p.retailer,
    name: p.name,
    description: p.description,
    category: p.category,
    gtin: p.gtin,
    manual_facts: p.manual_facts ?? {},
  };
}
