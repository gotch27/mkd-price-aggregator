import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { settings } from "@/nextsignal/config";
import { families, type Family } from "@/nextsignal/domain/matching";
import { hash } from "@/nextsignal/domain/normalize";

type PromptSettings = typeof settings.matching.prompts;
export type PromptFile = { path: string; content: string };
export type PromptBundle = {
  operation: "classification" | "comparison" | "clarification";
  key: string;
  instructions: string;
  files: PromptFile[];
};
export function loadPromptCatalog(config: PromptSettings) {
  const root = resolve(config.root);
  function read(path: string): PromptFile {
    const resolved = resolve(root, path),
      local = relative(root, resolved);
    if (isAbsolute(path) || local.startsWith("..") || isAbsolute(local))
      throw new Error(`Prompt path must stay inside ${config.root}: ${path}`);
    const content = readFileSync(resolved, "utf8").trim();
    if (!content) throw new Error(`Prompt file is empty: ${path}`);
    return { path, content };
  }
  const agentReview = read(settings.agent_review.instructions_file);
  const classification = read(config.classification),
    comparison = read(config.comparison),
    clarification = read(config.clarification);
  const question = read(config.comparison_question);
  const categoriesFile = read(config.categories),
    answersFile = read(config.comparison_answers);
  const categories = z
    .record(z.enum(families), z.string().min(1))
    .parse(JSON.parse(categoriesFile.content));
  const answers = z
    .strictObject({
      same: z.string().min(1),
      different: z.string().min(1),
      insufficient: z.string().min(1),
    })
    .parse(JSON.parse(answersFile.content));
  const stores = Object.fromEntries(
    Object.entries(config.stores).map(([id, path]) => [id, read(path)]),
  );
  const profiles = Object.fromEntries(
    families.map((id) => [id, read(config.families[id])]),
  );
  function bundle(
    operation: "classification" | "comparison" | "clarification",
    retailers: string[],
    selectedFamilies: Family[],
  ): PromptBundle {
    const base = { classification, comparison, clarification }[operation];
    const text = [
      base,
      ...[...new Set(retailers)].sort().map((id) => {
        if (!stores[id]) throw new Error(`Store prompt missing: ${id}`);
        return stores[id];
      }),
      ...[...new Set(selectedFamilies)].sort().map((id) => profiles[id]),
    ];
    const files = [
      ...text,
      ...(operation === "classification"
        ? [categoriesFile]
        : operation === "comparison"
          ? [answersFile, question]
          : []),
    ];
    return {
      operation,
      key: hash(files),
      instructions: text.map((file) => file.content).join("\n\n"),
      files,
    };
  }
  return {
    categories,
    answers,
    question: question.content,
    bundle,
    agentReview: agentReview.content,
    storeGuidance: (retailer: string) => {
      if (!stores[retailer])
        throw new Error(`Store prompt missing: ${retailer}`);
      return stores[retailer].content;
    },
  };
}
// Fail at application/worker startup on missing prompts. Restart after editing;
// each running process uses a consistent immutable catalog of source files.
export const matchingPrompts = loadPromptCatalog(settings.matching.prompts);
