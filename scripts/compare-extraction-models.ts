import {
  readCatalog,
  rulesFromCatalog,
} from "@/nextsignal/services/brand-catalog";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import { ensureCampaign } from "@/nextsignal/services/matching-repository";
import {
  clarificationMessages,
  clarificationSchema,
  extractionExperiment,
} from "@/nextsignal/services/ai-gateway";
import { validateClarification } from "@/nextsignal/domain/clarification";
import { canonicalFactValue } from "@/nextsignal/domain/product-facts";
import {
  familyFromText,
  type FactName,
  type StoreProduct,
} from "@/nextsignal/domain/matching";

if (!new URL(settings.database.url).pathname.endsWith("_matching_test"))
  throw new Error("Only the isolated matching test database is permitted");
if (!process.argv.includes("--paid") || !settings.matching.gateway.enabled)
  throw new Error("Explicit --paid and isolated Gateway enablement required");
const dataset = JSON.parse(
  await readFile(
    "tests/fixtures/independent-store-matching-evaluation.json",
    "utf8",
  ),
);
// Freeze expectations BEFORE making requests. These are literal text-reading
// checks, not product group accuracy measurements. Null means source is silent.
const cases: {
  index: number;
  expected: Partial<Record<FactName, string | null>>;
}[] = [
  {
    index: 0,
    expected: {
      brand: "КАН БЕБЕ",
      pack: "80",
      size: null,
      quantity: null,
      unit: null,
    },
  },
  {
    index: 3,
    expected: {
      brand: "КАН БЕБЕ",
      pack: "40",
      size: "4",
      quantity: null,
      unit: null,
    },
  },
  {
    index: 4,
    expected: {
      brand: "ДР БЕННЕР",
      type: "ГРАНОЛА",
      quantity: "40",
      unit: "g",
    },
  },
  { index: 10, expected: { brand: "РАНЧО", quantity: "295", unit: "g" } },
  {
    index: 16,
    expected: { brand: "КОСИЛИ", type: "КУПКА", quantity: "200", unit: "ml" },
  },
  {
    index: 20,
    expected: { brand: "MAGNUM", pack: "6", quantity: "55", unit: "ml" },
  },
  {
    index: 23,
    expected: {
      brand: "ШТАРК",
      type: "НАПОЛИТАНКИ",
      quantity: "130",
      unit: "g",
    },
  },
  {
    index: 30,
    expected: { model: "H103-49", quantity: null, unit: null, brand: null },
  },
  {
    index: 34,
    expected: { brand: "GARNIER", shade: "6", quantity: null, unit: null },
  },
  { index: 51, expected: { pack: "100", quantity: null, unit: null } },
  {
    index: 58,
    expected: { brand: "HIT", range: "MINI", quantity: "500", unit: "g" },
  },
  {
    index: 68,
    expected: {
      brand: "ВОЧНА ДОЛИНА",
      quantity: "1500",
      unit: "ml",
      pack: null,
    },
  },
];
try {
  const models = await (
    await fetch(new URL("models", settings.matching.gateway.base_url), {
      signal: AbortSignal.timeout(settings.matching.gateway.timeout_ms),
    })
  ).json();
  const profiles = [
    "stealth/glyph-cluster",
    settings.matching.gateway.extraction_model,
  ].map((model) => {
    const info = models.data.find((m: { id: string }) => m.id === model);
    if (!info || !info.pricing)
      throw new Error(`Missing live pricing for ${model}`);
    return {
      model,
      input_per_million: Number(info.pricing.input) * 1e6,
      output_per_million: Number(info.pricing.output) * 1e6,
    };
  });
  const campaign = await ensureCampaign("evaluation");
  const brandCatalog = await readCatalog(pool);
  const results: Record<string, unknown>[] = [];
  await mkdir(".data/model-comparison", { recursive: true });
  const schema = z.toJSONSchema(clarificationSchema);
  delete schema.$schema;
  for (const [i, test] of cases.entries()) {
    const source = dataset.products[test.index];
    const localRules = rulesFromCatalog(brandCatalog, source.retailer);
    const product = {
      ...source,
      family: familyFromText(
        source,
        source.retailer,
        settings.matching.category_mappings,
      ),
      facts: {},
    } as StoreProduct;
    const fields = Object.keys(test.expected) as FactName[];
    for (const profile of i % 2 ? [...profiles].reverse() : profiles) {
      const started = Date.now();
      let result: Record<string, unknown> = {
        sample: i + 1,
        model: profile.model,
        name: source.name,
        expected: test.expected,
      };
      try {
        const messages = clarificationMessages(product, fields);
        messages[0].content += ` Return ONLY a JSON object matching this schema, no markdown or other text: ${JSON.stringify(schema)}`;
        const raw = await extractionExperiment(
          campaign,
          {
            messages,
            temperature: 0,
            stream: false,
            reasoning_effort: "low",
            max_tokens: 3072,
          },
          profile,
        );
        const choices = raw.choices as {
          message: { content: string };
          finish_reason: string;
        }[];
        const content = choices[0]?.message.content;
        const parsed = clarificationSchema.safeParse(JSON.parse(content));
        if (!parsed.success) throw new Error("invalid_schema");
        const validated = validateClarification(
          product,
          parsed.data.facts,
          fields,
          localRules,
        );
        const checks = fields.map((field) => {
          const expected = test.expected[field];
          const actual = validated.facts[field]?.value ?? null;
          const normalized =
            expected === null
              ? null
              : ["quantity", "pack", "size"].includes(field)
                ? expected
                : canonicalFactValue(field, expected!, localRules);
          return {
            field,
            expected: normalized,
            actual,
            correct: actual === normalized,
          };
        });
        result = {
          ...result,
          schema_valid: true,
          finish_reason: choices[0]?.finish_reason,
          raw: parsed.data,
          validated: validated.facts,
          rejected: validated.rejected,
          checks,
          all_correct: checks.every((c) => c.correct),
          accounting: raw.__accounting,
          cached: raw.__cached,
        };
      } catch (error) {
        result = {
          ...result,
          error: error instanceof Error ? error.message : "Unknown failure",
        };
      }
      results.push({ ...result, duration_ms: Date.now() - started });
      await writeFile(
        ".data/model-comparison/glyph-vs-qwen.json",
        JSON.stringify(
          { campaign_id: campaign.id, profiles, cases, results },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          sample: i + 1,
          model: profile.model,
          correct: result.all_correct,
          error: result.error,
          duration_ms: Date.now() - started,
        }),
      );
      if (result.error && i === 0) {
        await pool.query(
          "UPDATE matching_campaigns SET state='paused',paused_at=now(),reason=$2 WHERE id=$1",
          [campaign.id, `Model comparison blocked for ${profile.model}`],
        );
        throw new Error(
          `First sample failed for ${profile.model}; inspect the saved report before spending more`,
        );
      }
    }
  }
  await pool.query(
    "UPDATE matching_campaigns SET state='completed',completed_at=now() WHERE id=$1",
    [campaign.id],
  );
} finally {
  await pool.end();
}
