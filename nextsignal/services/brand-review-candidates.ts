import { settings } from "@/nextsignal/config";
import { normalizeName, hash } from "@/nextsignal/domain/normalize";
import { readableProductText } from "@/nextsignal/domain/product-text";
import type { StoreProduct } from "@/nextsignal/domain/matching";
import type {
  BrandExample,
  BrandReviewStart,
} from "@/nextsignal/domain/brand-review";
import { identityCatalog } from "./identity-catalog";
import { matchingPrompts } from "./matching-prompts";
import { readCatalog, rulesFromCatalog } from "./brand-catalog";
import { availableProductSql } from "./product-availability";
import type { PoolClient } from "pg";

function quoteFor(name: string, retailer: string, term: string) {
  const pieces = [...name.matchAll(/\S+/gu)];
  for (let start = 0; start < pieces.length; start++)
    for (let length = 1; length <= term.split(" ").length; length++) {
      const last = pieces[start + length - 1];
      if (!last) continue;
      const quote = name.slice(
        pieces[start].index,
        last.index + last[0].length,
      );
      if (normalizeName(readableProductText(quote, retailer)) === term)
        return quote;
    }
  return null;
}
export async function reviewCandidates(c: PoolClient, input: BrandReviewStart) {
  const language = matchingPrompts.brandLanguage;
  const stop = new Set(
    [
      ...language.stop_words,
      ...identityCatalog.profiles.flatMap((p) => p.type_aliases),
      ...Object.values(identityCatalog.aliases).flatMap((v) =>
        Object.values(v).flat(),
      ),
    ].flatMap((v) => normalizeName(v).split(" ")),
  );
  const search = normalizeName(input.search).replace(/[\\%_]/g, "\\$&");
  const products = (
    await c.query<StoreProduct>(
      `SELECT sp.*,sp.version::int version FROM store_products sp WHERE sp.brand_id IS NULL AND NOT(sp.manual_facts ? 'brand') AND ${availableProductSql("sp")} AND NOT EXISTS(SELECT 1 FROM store_product_redirects r WHERE r.from_id=sp.id) AND ($1::text IS NULL OR sp.retailer=$1) AND ($2='' OR sp.normalized_name ILIKE '%'||$2||'%') AND ($3 OR NOT EXISTS(SELECT 1 FROM brand_review_skips skipped WHERE skipped.store_product_id=sp.id AND skipped.fingerprint=sp.fingerprint)) ORDER BY sp.id LIMIT $4`,
      [
        input.retailer ?? null,
        search,
        input.include_previously_skipped,
        settings.brand_review.scan_products,
      ],
    )
  ).rows;
  const catalog = await readCatalog(c);
  const groups = new Map<
    string,
    { term: string; examples: BrandExample[]; ids: Set<string> }
  >();
  for (const p of products) {
    const text = normalizeName(readableProductText(p.name, p.retailer));
    const rules = rulesFromCatalog(catalog, p.retailer);
    if (
      rules.brands.some((b) =>
        b.aliases.some((a) => ` ${text} `.includes(` ${normalizeName(a)} `)),
      )
    )
      continue;
    const all = text.split(" ").filter((t) => /^[a-z][a-z-]+$/i.test(t));
    const words = all.filter((t) => !stop.has(t));
    const terms = new Set(
      [
        p.facts.brand?.value,
        words[0],
        words.slice(0, 2).join(" "),
        words.at(-1),
      ].filter((v): v is string => !!v),
    );
    for (const term of terms) {
      const quote = quoteFor(p.name, p.retailer, term);
      if (!quote || term.split(" ").every((word) => stop.has(word))) continue;
      const group = groups.get(term) ?? {
        term,
        examples: [],
        ids: new Set<string>(),
      };
      group.ids.add(p.id);
      const example: BrandExample = {
        id: p.id,
        fingerprint: p.fingerprint,
        retailer: p.retailer,
        name: p.name,
        description: p.description,
        category: p.category,
        readable_name: readableProductText(p.name, p.retailer),
        quote,
        field: "name",
      };
      if (group.examples.length < settings.brand_review.examples_per_group)
        group.examples.push(example);
      else if (!group.examples.some((e) => e.retailer === p.retailer))
        group.examples[group.examples.length - 1] = example;
      groups.set(term, group);
    }
  }
  // Candidates are source groupings, not assertions that a token is a brand.
  return [...groups.values()]
    .sort((a, b) => b.ids.size - a.ids.size || a.term.localeCompare(b.term))
    .map((g) => ({
      term: g.term,
      examples: g.examples,
      affected: g.ids.size,
      input_key: hash([
        g.term,
        g.examples.map((e) => [e.id, e.fingerprint, e.quote]),
      ]),
    }));
}
