import { expect, it } from "vitest";
import { rulesFromCatalog } from "@/nextsignal/services/brand-catalog";
import { prepareFacts } from "@/nextsignal/domain/matching";

it("uses the product's store when the same spelling means different brands", () => {
  const snapshot = [
    { slug: "scoped-kam", name: "shared spelling", retailer: "kam" },
    { slug: "scoped-spar", name: "shared spelling", retailer: "spar" },
    { slug: "global-brand", name: "global spelling", retailer: null },
  ];
  const facts = (retailer: string, name = "Shared Spelling shower gel 250ml") =>
    prepareFacts(
      {
        name,
        description: null,
        category: null,
        gtin: null,
        ambiguous: false,
        retailer,
      },
      "personal_care",
      rulesFromCatalog(snapshot, retailer),
    );
  expect(facts("kam").brand?.value).toBe("scoped-kam");
  expect(facts("spar").brand?.value).toBe("scoped-spar");
  expect(facts("vero").brand).toBeUndefined();
  expect(facts("vero", "Global Spelling shower gel 250ml").brand?.value).toBe(
    "global-brand",
  );
});
