import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import {
  evaluationDataset,
  type EvaluationDataset,
} from "@/nextsignal/domain/matching-evaluation";
const seed = process.argv[2];
if (!seed)
  throw new Error("Usage: npm run matching:sample -- SEED [OUTPUT.json]");
const output = process.argv[3] ?? ".data/matching-evaluation/dataset.json";
const stableId = (value: string) => {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const client = await pool.connect();
try {
  // Read-only sampling: no imports, backfill, matching, or provider calls.
  await client.query("BEGIN READ ONLY");
  const canonicalBrowser = (
    await client.query("SELECT to_regclass('store_product_browser') IS NOT NULL AS present")
  ).rows[0].present;
  // Review must also work before the application schema is upgraded. Both
  // relations contain one row per store identity, rather than branch copies.
  const browser = canonicalBrowser ? "store_product_browser" : "catalog_browser";
  const data = (
    await client.query(
      `WITH ranked AS (
    SELECT b.*,
      row_number() OVER(PARTITION BY b.retailer ORDER BY md5($1||b.retailer||b.external_key||b.identity_hash)) AS position
    FROM ${browser} b WHERE b.usable_name
  ) SELECT b.*,l.description,l.gtin,l.raw->>'identity_ambiguous'='true' AS ambiguous
    FROM ranked b JOIN listings l ON l.id=b.listing_id
    WHERE position<=$2 ORDER BY retailer,position`,
      [seed, settings.matching.evaluation.sample_per_store],
    )
  ).rows;
  const products: EvaluationDataset["products"] = [];
  const cases: EvaluationDataset["cases"] = [];
  const anchors: string[] = [];
  for (const row of data) {
    const id = stableId(
      `${seed}:${row.retailer}:${row.external_key}:${row.identity_hash}`,
    );
    const split =
      parseInt(
        createHash("sha256")
          .update(seed + id)
          .digest("hex")
          .slice(0, 8),
        16,
      ) %
        settings.matching.evaluation.holdout_divisor ===
      0
        ? "holdout"
        : "development";
    if (!products.some((p) => p.id === id))
      products.push({
        id,
        retailer: row.retailer,
        name: row.name,
        description: row.description,
        category: row.category,
        gtin: row.gtin,
        ambiguous: row.ambiguous === true,
        split,
      });
    anchors.push(id);
    const nearby = (
      await client.query(
        `SELECT b.*,l.description,l.gtin,l.raw->>'identity_ambiguous'='true' AS ambiguous FROM ${browser} b JOIN listings l ON l.id=b.listing_id
      WHERE b.retailer<>$1 AND b.usable_name AND b.normalized_name % $2
      ORDER BY similarity(b.normalized_name,$2) DESC,b.retailer,b.external_key LIMIT $3`,
        [row.retailer, row.normalized_name, settings.matching.candidate_limit],
      )
    ).rows;
    for (const candidate of nearby) {
      const otherId = stableId(
        `${seed}:${candidate.retailer}:${candidate.external_key}:${candidate.identity_hash}`,
      );
      if (!products.some((p) => p.id === otherId))
        products.push({
          id: otherId,
          retailer: candidate.retailer,
          name: candidate.name,
          description: candidate.description,
          category: candidate.category,
          gtin: candidate.gtin,
          ambiguous: candidate.ambiguous === true,
          split,
        });
      cases.push({
        id: `${id}:${otherId}`,
        a: id,
        b: otherId,
        expected: null,
        reviewed: false,
        split,
      });
    }
  }
  await client.query("ROLLBACK");
  // Connected case components share one split, avoiding alternate spellings of
  // the same reviewed product leaking between development and held-out checks.
  const parent = new Map(products.map((p) => [p.id, p.id]));
  const root = (id: string): string =>
    parent.get(id) === id ? id : root(parent.get(id)!);
  for (const c of cases) {
    const a = root(c.a),
      b = root(c.b);
    if (a !== b) parent.set(b, a);
  }
  for (const p of products)
    p.split =
      parseInt(
        createHash("sha256")
          .update(seed + root(p.id))
          .digest("hex")
          .slice(0, 8),
        16,
      ) %
        settings.matching.evaluation.holdout_divisor ===
      0
        ? "holdout"
        : "development";
  for (const c of cases) c.split = products.find((p) => p.id === c.a)!.split;
  const controls = evaluationDataset.parse(
    JSON.parse(
      await readFile("tests/fixtures/store-matching-evaluation.json", "utf8"),
    ),
  );
  const dataset = evaluationDataset.parse({
    version: 1,
    seed,
    provenance:
      "Seeded random imported store products plus suggested candidates and 30 separately identified constructed controls. Random counterpart expectations require human verification; suggestions are not ground truth.",
    products: [...products, ...controls.products],
    anchors,
    cases: [...cases, ...controls.cases],
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(dataset, null, 2), { flag: "wx" });
  await writeFile(
    output.replace(/\.json$/, ".md"),
    `# Store product review\n\nSeed: ${seed}. ${anchors.length} random anchors. Suggested counterparts are unverified. Thirty constructed controls are included separately in the dataset.\n\n${anchors
      .map((id) => {
        const p = products.find((p) => p.id === id)!;
        return `## ${p.retailer}: ${p.name}\n\n${
          cases
            .filter((c) => c.a === id)
            .map((c) => {
              const other = products.find((p) => p.id === c.b)!;
              return `- ${other.retailer}: ${other.name} — awaiting review`;
            })
            .join("\n") || "No candidate found."
        }\n`;
      })
      .join("\n")}`,
    { flag: "wx" },
  );
  console.info({
    anchors: anchors.length,
    by_store: Object.fromEntries(
      Object.keys(settings.sources).map((r) => [
        r,
        data.filter((p) => p.retailer === r).length,
      ]),
    ),
    candidate_pairs: cases.length,
    browser,
    output,
    provider_calls: 0,
  });
} finally {
  // Also ends the read-only transaction if a query or file operation failed.
  client.release(true);
  await pool.end();
}
