import { expect, it } from "vitest";
import { categoryScores } from "@/nextsignal/domain/category-scores";
import { families } from "@/nextsignal/domain/matching";

it("sorts saved probabilities with stable selected-label tie breaking, preserving zero", () => {
  const scores = categoryScores(
    { dairy: 0.2, fruit: 0.4, vegetables: 0.4, alcohol: 0 },
    "vegetables",
  );
  expect(scores.map((s) => s.category).slice(0, 4)).toEqual([
    "vegetables",
    "fruit",
    "dairy",
    "alcohol",
  ]);
  expect(scores[3].probability).toBe(0);
  expect(scores).toHaveLength(families.length);
  expect(scores.find((s) => s.category === "soft_drinks")).toEqual({
    category: "soft_drinks",
    label: "Soft drinks",
    probability: null,
  });
});

it.each([
  null,
  undefined,
  [],
  "malformed",
  { fruit: -1, dairy: 2, vegetables: "0.5", alcohol: NaN, baby_food: Infinity },
])(
  "does not invent probabilities for missing or malformed scores: %j",
  (input) => {
    expect(
      categoryScores(input, null).every((s) => s.probability === null),
    ).toBe(true);
  },
);

it("never presents unrecognized provider labels as available categories", () => {
  const scores = categoryScores(
    { fruit: 0.75, invented_category: 1 },
    "invented_category",
  );
  expect(scores[0]).toMatchObject({ category: "fruit", probability: 0.75 });
  expect(scores.map((s) => s.category)).not.toContain("invented_category");
});
