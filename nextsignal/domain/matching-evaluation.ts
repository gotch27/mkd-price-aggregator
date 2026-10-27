import { z } from "zod";
export const evaluationProduct = z.object({
  id: z.uuid(),
  retailer: z.enum([
    "kam",
    "spar",
    "vero",
    "ramstore",
    "dim",
    "zito",
    "zur",
    "stokomak",
    "reptil",
  ]),
  name: z.string().min(1),
  description: z.string().nullable(),
  category: z.string().nullable(),
  gtin: z.string().nullable(),
  ambiguous: z.boolean(),
  split: z.enum(["development", "holdout"]),
});
export const evaluationDataset = z.object({
  version: z.literal(1),
  seed: z.string().min(1),
  provenance: z.string(),
  products: z.array(evaluationProduct),
  anchors: z.array(z.uuid()),
  cases: z.array(
    z.object({
      id: z.string(),
      a: z.uuid(),
      b: z.uuid(),
      expected: z.enum(["same", "different", "insufficient"]).nullable(),
      reviewed: z.boolean(),
      split: z.enum(["development", "holdout"]),
    }),
  ),
});
export type EvaluationDataset = z.infer<typeof evaluationDataset>;
