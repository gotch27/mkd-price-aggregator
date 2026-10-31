// Read-only source snapshot and untouched sample. Never calls a model or enqueues work.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import { availableProductSql } from "@/nextsignal/services/product-availability";
import { hash } from "@/nextsignal/domain/normalize";
import type { StoreProduct } from "@/nextsignal/domain/matching";
import { prepareIdentity } from "@/nextsignal/domain/matching-identity";
import { identityCatalog } from "@/nextsignal/services/identity-catalog";
import { matchingRules } from "@/nextsignal/services/brand-catalog";
const options = settings.matching.evaluation;
const path = process.argv[2] ?? options.identity_dataset_path;
const developmentPath = process.argv[3] ?? options.identity_development_path;
try {
  const development = JSON.parse(await readFile(developmentPath, "utf8"));
  const excluded = new Set<string>(
    development.products.map((p: StoreProduct) => p.id),
  );
  for (const d of development.decisions) {
    excluded.add(d.store_product_id);
    if (d.candidate_id) excluded.add(d.candidate_id);
  }
  const client = await pool.connect();
  let products: StoreProduct[];
  let brands: { id: string; slug: string; name: string }[];
  let aliases: {
    id: string;
    brand_id: string;
    name: string;
    normalized_name: string;
    retailer: string | null;
  }[];
  try {
    await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
    products = (
      await client.query<StoreProduct>(
        `SELECT sp.*,sp.version::int AS version FROM store_products sp WHERE sp.classified_family=ANY($1::text[]) AND ${availableProductSql("sp")} AND NOT sp.ambiguous AND NOT sp.branch_conflict AND NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id) ORDER BY sp.id`,
        [["soft_drinks", "dairy"]],
      )
    ).rows;
    brands = (
      await client.query("SELECT id,slug,name FROM brands ORDER BY slug")
    ).rows;
    aliases = (
      await client.query(
        "SELECT id,brand_id,name,normalized_name,retailer FROM brand_aliases ORDER BY id",
      )
    ).rows;
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  const rules = await matchingRules();
  const identity = (p: StoreProduct) => {
    const x = prepareIdentity(
      p,
      rules,
      settings.matching.category_mappings,
      identityCatalog,
    );
    return (
      x.local_key ??
      hash([
        x.facts.brand?.value,
        x.facts.type?.value,
        x.facts.quantity?.value,
        x.facts.unit?.value,
        x.facts.flavour?.value,
        x.facts.variant?.value,
        x.facts.fat?.value,
        x.facts.range?.value,
      ])
    );
  };
  const excludedGroups = new Set(
    products.filter((p) => excluded.has(p.id)).map(identity),
  );
  const eligible = products.filter(
    (p) => !excluded.has(p.id) && !excludedGroups.has(identity(p)),
  );
  const anchors = ["soft_drinks", "dairy"].flatMap((family) =>
    eligible
      .filter((p) => p.classified_family === family)
      .sort((a, b) =>
        hash([options.identity_seed, a.id]).localeCompare(
          hash([options.identity_seed, b.id]),
        ),
      )
      .slice(0, options.identity_anchors_per_family)
      .map((p) => p.id),
  );
  const dataset = {
    version: 1,
    seed: options.identity_seed,
    profile_version: hash(identityCatalog),
    provenance:
      "Read-only compact current available soft-drink/dairy catalog. Anchor groups appearing in the frozen development retrieval pool are excluded. Source expectations must be reviewed before paid execution.",
    products,
    brands,
    brand_aliases: aliases,
    anchors,
    cases: [],
    required_controls: options.identity_controls,
    review_complete: false,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(dataset, null, 2));
  console.log(
    JSON.stringify({
      path,
      products: products.length,
      anchors: anchors.length,
      controls_required: options.identity_controls,
      paid_calls: 0,
    }),
  );
} finally {
  await pool.end();
}
