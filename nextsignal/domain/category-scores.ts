import { families } from "./matching";
import type { ProductClassification } from "./dashboard";

export function categoryScores(
  probabilities: unknown,
  selected: string | null,
): ProductClassification["options"] {
  const values =
    probabilities &&
    typeof probabilities === "object" &&
    !Array.isArray(probabilities)
      ? (probabilities as Record<string, unknown>)
      : {};
  return families
    .map((category) => {
      const raw = values[category];
      return {
        category,
        label: category
          .replaceAll("_", " ")
          .replace(/^./, (c) => c.toUpperCase()),
        probability:
          typeof raw === "number" &&
          Number.isFinite(raw) &&
          raw >= 0 &&
          raw <= 1
            ? raw
            : null,
      };
    })
    .sort(
      (a, b) =>
        (b.probability ?? -1) - (a.probability ?? -1) ||
        Number(b.category === selected) - Number(a.category === selected) ||
        families.indexOf(a.category) - families.indexOf(b.category),
    );
}
