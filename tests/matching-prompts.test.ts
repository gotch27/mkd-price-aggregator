import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { settings } from "@/nextsignal/config";
import { loadPromptCatalog } from "@/nextsignal/services/matching-prompts";
import { configSchema } from "@/nextsignal/config";

it("loads only relevant store/category prompts and archives complete source content", () => {
  const catalog = loadPromptCatalog(settings.matching.prompts);
  const bundle = catalog.bundle(
    "comparison",
    ["kam", "spar", "spar"],
    ["dairy", "dairy"],
  );
  expect(bundle.files.map((f) => f.path)).toEqual([
    "matching.md",
    "stores/kam.md",
    "stores/spar.md",
    "families/dairy.md",
    "matching-identity.json",
    "matching-answers.json",
    "matching-question.md",
  ]);
  expect(bundle.instructions).toContain("fat percentage");
  expect(bundle.files.every((f) => f.content.length > 0)).toBe(true);
  expect(catalog.categories.other).not.toEqual(catalog.categories.unknown);
});
it("changes only affected prompt versions and rejects missing/empty/traversing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "matching-prompts-"));
  try {
    await cp(settings.matching.prompts.root, root, { recursive: true });
    const config = { ...structuredClone(settings.matching.prompts), root };
    const before = loadPromptCatalog(config);
    await writeFile(
      join(root, "families/dairy.md"),
      (await readFile(join(root, "families/dairy.md"), "utf8")) +
        "\nTest dairy wording\n",
    );
    const after = loadPromptCatalog(config);
    expect(before.bundle("classification", ["kam"], []).key).toBe(
      after.bundle("classification", ["kam"], []).key,
    );
    expect(before.bundle("comparison", ["kam"], ["cleaning"]).key).toBe(
      after.bundle("comparison", ["kam"], ["cleaning"]).key,
    );
    expect(before.bundle("comparison", ["kam"], ["dairy"]).key).not.toBe(
      after.bundle("comparison", ["kam"], ["dairy"]).key,
    );
    expect(() =>
      loadPromptCatalog({ ...config, classification: "../outside.md" }),
    ).toThrow("inside");
    expect(() =>
      loadPromptCatalog({ ...config, classification: "missing.md" }),
    ).toThrow();
    await writeFile(join(root, "classification.md"), "   ");
    expect(() => loadPromptCatalog(config)).toThrow("empty");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("requires explicit category selection and complete prompt configuration", () => {
  const missing = structuredClone(settings) as unknown as {
    matching: Record<string, unknown>;
  };
  delete missing.matching.ai_categories;
  expect(configSchema.safeParse(missing).success).toBe(false);
  expect(
    configSchema.safeParse({
      ...settings,
      matching: { ...settings.matching, ai_categories: ["invented-label"] },
    }).success,
  ).toBe(false);
  expect(
    configSchema.safeParse({
      ...settings,
      matching: {
        ...settings.matching,
        prompts: { ...settings.matching.prompts, stores: {} },
      },
    }).success,
  ).toBe(false);
});

it("versions review definitions independently without invalidating decision-model categories", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-definitions-"));
  try {
    await cp(settings.matching.prompts.root, root, { recursive: true });
    const config = { ...structuredClone(settings.matching.prompts), root };
    const before = loadPromptCatalog(config);
    const reviewPath = join(root, settings.llm_review.categories_file);
    const definitions = JSON.parse(await readFile(reviewPath, "utf8"));
    definitions.household += " Test an updated review boundary.";
    await writeFile(reviewPath, JSON.stringify(definitions));
    const after = loadPromptCatalog(config);
    expect(after.reviewCategories.household).toEqual(definitions.household);
    expect(after.categories).toEqual(before.categories);
    expect(after.bundle("llm_review", ["spar"], []).key).not.toEqual(
      before.bundle("llm_review", ["spar"], []).key,
    );
    expect(after.bundle("classification", ["spar"], [])).toEqual(
      before.bundle("classification", ["spar"], []),
    );
    expect(after.bundle("comparison", ["spar"], ["dairy"])).toEqual(
      before.bundle("comparison", ["spar"], ["dairy"]),
    );
    expect(
      after
        .bundle("llm_review", ["spar"], [])
        .files.some(
          (f) =>
            f.path === settings.llm_review.categories_file &&
            f.content.includes("Test an updated review boundary"),
        ),
    ).toBe(true);
    delete definitions.unknown;
    await writeFile(reviewPath, JSON.stringify(definitions));
    expect(() => loadPromptCatalog(config)).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
