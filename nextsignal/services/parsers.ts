import Decimal from "decimal.js";
import { load } from "cheerio";
import { hash, money } from "@/nextsignal/domain/normalize";
import {
  SourceError,
  type CatalogRow,
  type Retailer,
} from "@/nextsignal/domain/types";
export function tableRows(html: string): string[][] {
  const $ = load(/<table[\s>]/i.test(html) ? html : `<table>${html}</table>`);
  return $("tr")
    .toArray()
    .map((tr) =>
      $(tr)
        .children("td,th")
        .toArray()
        .map((td) => $(td).text().replace(/\s+/g, " ").trim()),
    );
}
const optional = (value: string | undefined) =>
  value && value !== "-" && value !== "/" ? value : null;
function availability(value: string | undefined): boolean | null {
  if (!value) return null;
  const n = value.trim().toLowerCase();
  return ["да", "yes", "1", "true"].includes(n)
    ? true
    : ["не", "no", "0", "false"].includes(n)
      ? false
      : null;
}
export function parseTable(
  html: string,
  retailer: Retailer,
  pricePolicy: "reject" | "preserve_unknown",
): CatalogRow[] {
  const rows = tableRows(html);
  const result: CatalogRow[] = [];
  for (const c of rows) {
    const code = retailer === "zur" || retailer === "dim",
      vero = retailer === "vero";
    const n = code ? 1 : 0,
      p = code ? 2 : 1;
    const price = money(c[p]);
    if (price === null) {
      if (c.length < 6 || /^(назив|шифра|промотивна|цена со)/i.test(c[n]))
        continue;
      if (pricePolicy === "reject")
        throw new SourceError(
          `Unparseable ${retailer} selling price for ${c[n]}`,
          false,
        );
    }
    if (!c[n] || c.length < (code ? 7 : 6))
      throw new SourceError(`Malformed ${retailer} price row`, false);
    const description = code ? c[4] : vero ? c[4] : c[3];
    const regular = code ? c[6] : c[5],
      promo = code ? c[7] : c[6];
    result.push({
      key: code ? c[0] : hash([c[n], description]),
      name: c[n],
      description: optional(description),
      category: optional(description),
      gtin: null,
      price,
      regular_price: money(regular),
      promo_price: money(promo?.match(/^([\d.,]+)\s+Попуст:/)?.[1] ?? promo),
      unit_price: optional(c[code ? 3 : 2]),
      available: availability(c[code ? 5 : vero ? 3 : 4]),
      promotion: optional(c.slice(code ? 8 : vero ? 8 : 7).join(" | ")),
      source_updated_at: null,
      raw: { cells: c, price_parse_error: price === null },
    });
  }
  return result;
}
export function parseSpar(data: Record<string, unknown>[]): CatalogRow[] {
  return data.map((r) => {
    const price = money(r.sale);
    if (price === null || !r.id || typeof r.name !== "string")
      throw new SourceError("SPAR returned an invalid product", false);
    return {
      key: String(r.id),
      name: r.name,
      description: null,
      category: typeof r.category === "string" ? r.category : null,
      gtin: null,
      price,
      regular_price: money(r.regular),
      promo_price: money(r.discount_price),
      unit_price: r.unit === null ? null : String(r.unit),
      available: availability(String(r.available)),
      promotion: [r.action, r.date].filter(Boolean).join(" | ") || null,
      source_updated_at: null,
      raw: r,
    };
  });
}
export function selectedBranches(html: string) {
  const $ = load(html);
  return $('select[name="org"] option,select#org-list option')
    .toArray()
    .map((el) => ({ id: $(el).attr("value"), name: $(el).text().trim() }))
    .filter((r): r is { id: string; name: string } => !!r.id);
}
export function pagination(html: string, base: string) {
  const $ = load(html);
  const pages = $("a[href]")
    .toArray()
    .map((el) => new URL($(el).attr("href")!, base))
    .filter((u) => u.host === new URL(base).host);
  return pages;
}
export function publishedCounts(html: string) {
  const text = load(html).text().replace(/\s+/g, " ");
  const match = text.match(
    /Прикажи\s+([\d.,]+)\s*-\s*([\d.,]+)\s+од\s+([\d.,]+)\s+артикли/i,
  );
  if (!match)
    throw new SourceError("Published catalog row counts are missing", false);
  const [from, to, total] = match
    .slice(1)
    .map((value) => Number(value.replace(/[.,]/g, "")));
  if (
    ![from, to, total].every(Number.isSafeInteger) ||
    (from < 1 && total > 0) ||
    from < 0 ||
    to < 0 ||
    total < to
  )
    throw new SourceError("Published catalog row counts are invalid", false);
  return { from, to, total };
}
export function parseKam(text: string): CatalogRow[] {
  const lines = text.replaceAll("\f", "\n").split("\n");
  const header = lines.find(
    (l) =>
      l.includes("Продажна") &&
      l.includes("Единична") &&
      l.includes("Достапност"),
  );
  const subheader = lines.find(
    (l) => l.includes("Цена со") && l.includes("Времетраење"),
  );
  if (!header || !subheader)
    throw new SourceError("KAM PDF column headers changed", false);
  const boundaries = [
    0,
    header.indexOf("Продажна"),
    header.indexOf("Единична"),
    header.indexOf("Опис на"),
    header.indexOf("Достапност"),
    header.indexOf("Редовна"),
    subheader.indexOf("Цена со"),
    subheader.indexOf("Вид на"),
    subheader.indexOf("Времетраење"),
  ];
  if (boundaries.some((n, i) => n < 0 || (i > 0 && n <= boundaries[i - 1])))
    throw new SourceError("KAM PDF column boundaries are invalid", false);
  const rows: CatalogRow[] = [];
  let current: { cells: string[]; raw: string[] } | null = null,
    readingHeader = true;
  const columns = (line: string) =>
    boundaries.map((start, i) => line.slice(start, boundaries[i + 1]).trim());
  function flush() {
    if (!current) return;
    const c = current.cells;
    const name = c[0],
      description = c[3] || null;
    const price = money(c[1]);
    if (!name || price === null)
      throw new SourceError(
        `Malformed KAM PDF row: ${JSON.stringify(current)}`,
        false,
      );
    rows.push({
      key: hash([name, description]),
      name,
      description,
      category: description,
      gtin: null,
      price,
      regular_price: money(c[5]),
      promo_price: money(c[6]),
      unit_price: c[2] || null,
      available: availability(c[4]),
      promotion:
        c
          .slice(6)
          .join(" | ")
          .replace(/^[ |]+|[ |]+$/g, "") || null,
      source_updated_at: null,
      raw: { lines: current.raw },
    });
    current = null;
  }
  for (const line of lines) {
    if (
      line.includes("Датум и време") ||
      (line.includes("Назив на") && line.includes("Продажна"))
    ) {
      flush();
      readingHeader = true;
      continue;
    }
    const c = columns(line);
    const starts = money(c[1]) !== null && c[0].length > 0;
    if (starts) {
      flush();
      readingHeader = false;
      current = { cells: c, raw: [line] };
      continue;
    }
    if (readingHeader || !current || !line.trim()) continue;
    current.raw.push(line);
    for (let i = 0; i < c.length; i++)
      if (c[i])
        current.cells[i] = [current.cells[i], c[i]].filter(Boolean).join(" ");
  }
  flush();
  // Some published branch PDFs contain a complete header and no products.
  // They enter the same independent empty-catalog confirmation as other sources.
  if (!rows.length && text.split("Попуст(%)").slice(1).join("").trim())
    throw new SourceError("KAM PDF has no readable product rows", false);
  return rows;
}

export function parseWoo(products: Record<string, unknown>[]): CatalogRow[] {
  return products.map((p) => {
    const prices = p.prices as {
      price: string;
      regular_price: string;
      sale_price: string;
      currency_minor_unit: number;
      currency_code: string;
      price_range: unknown;
    };
    if (
      !p.id ||
      typeof p.name !== "string" ||
      !prices ||
      !Number.isInteger(prices.currency_minor_unit) ||
      prices.currency_code !== "MKD"
    )
      throw new SourceError("Invalid Reptil public catalog product", false);
    const convert = (v: string) => {
      if (!/^\d+$/.test(v)) return null;
      return money(
        new Decimal(v)
          .div(new Decimal(10).pow(prices.currency_minor_unit))
          .toString(),
      );
    };
    const decode = (html: string) => load(html).text().trim();
    return {
      key: String(p.id),
      name: decode(p.name),
      description:
        typeof p.short_description === "string"
          ? decode(p.short_description)
          : null,
      category: Array.isArray(p.categories)
        ? p.categories.map((c) => (c as { name: string }).name).join(" | ")
        : null,
      gtin: typeof p.global_unique_id === "string" ? p.global_unique_id : null,
      price: prices.price_range === null ? convert(prices.price) : null,
      regular_price: convert(prices.regular_price),
      promo_price: p.on_sale === true ? convert(prices.sale_price) : null,
      unit_price:
        typeof p.price_html === "string"
          ? load(p.price_html)(".mcmp_recalc_price_row").text().trim() || null
          : null,
      available: typeof p.is_in_stock === "boolean" ? p.is_in_stock : null,
      promotion: p.on_sale === true ? "Published sale" : null,
      source_updated_at: null,
      raw: p,
    };
  });
}
