import { load, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import type { DiscoveredSource } from "@/nextsignal/domain/types";
import {
  decodeLegacyMacedonian,
  NAME_NORMALIZATION_VERSION,
} from "@/nextsignal/domain/name-encoding";

const text = (value: string) => value.replace(/\s+/g, " ").trim();

const legacyLatin: Readonly<Record<string, string>> = {
  Ж: "Ž",
  ж: "ž",
  Ш: "Š",
  ш: "š",
  Ѓ: "Ǵ",
  ѓ: "ǵ",
  Ќ: "Ḱ",
  ќ: "ḱ",
  Ч: "Č",
  ч: "č",
};
function sparDisplayText(value: string) {
  const decoded = decodeLegacyMacedonian(value);
  // SPAR publishes these names in Latin script. Convert only letters introduced
  // by legacy decoding; genuine Cyrillic input and brand/model names stay intact.
  return decoded.replace(/[ЖжШшЃѓЌќЧч]/g, (letter, offset: number) =>
    value[offset] === letter ? letter : legacyLatin[letter],
  );
}

function catalogUrl(href: string, base: string) {
  try {
    const url = new URL(href, base);
    return url.origin === new URL(base).origin ? url : null;
  } catch {
    return null;
  }
}

export function discoverVeroCatalogs(
  html: string,
  base: string,
): DiscoveredSource[] {
  return veroCards(html, base, false);
}

export function discoverVeroExcludedCatalogs(
  html: string,
  base: string,
): DiscoveredSource[] {
  return veroCards(html, base, true);
}

function veroCards(html: string, base: string, excluded: boolean) {
  const $ = load(html);
  const sources = new Map<string, DiscoveredSource>();
  for (const anchor of $("a[href]").toArray()) {
    const url = catalogUrl($(anchor).attr("href")!, base);
    const match = url?.pathname.match(/\/(\d+)_1\.html$/);
    if (!url || !match) continue;
    // Cheerio repairs Vero's malformed <a><h1>Jumbo</a></h1> into an
    // additional empty anchor. Its table cell remains the reliable store card.
    const card = $(anchor).closest("td");
    const rawName = text(card.find("h1,h2").first().text());
    if (
      !(
        excluded ? /^(?:ЏАМБО|JUMBO)\s+\d+$/iu : /^(?:ВЕРО|VERO)\s+\d+$/iu
      ).test(rawName)
    )
      continue;
    sources.set(match[1], {
      retailer: "vero",
      external_id: match[1],
      name: rawName,
      url: url.href,
      scope: "branch",
      meta: {
        raw_name: rawName,
        outlet_type: excluded ? "excluded_non_supermarket" : "supermarket",
        ...(excluded
          ? { exclusion_reason: "Jumbo is not a Vero supermarket" }
          : {}),
        discovery_url: base,
      },
    });
  }
  return [...sources.values()];
}

function ramstoreCardName($: CheerioAPI, element: AnyNode) {
  const card = $(element).closest(".store");
  if (card.length) return text(card.find("h2,h3").first().text());
  // Older markup used anchors in a div rather than the current store card.
  const container = $(element)
    .parents("div,article,li")
    .filter((_, parent) => $(parent).find("h2,h3").length === 1)
    .first();
  return text(container.find("h2,h3").first().text());
}

export function discoverRamstoreCatalogs(
  html: string,
  base: string,
): DiscoveredSource[] {
  const $ = load(html);
  const sources = new Map<string, DiscoveredSource>();
  const add = (href: string, rawName: string) => {
    const url = catalogUrl(href, base);
    if (!url || !/^\/marketi\/[^/]+\/$/.test(url.pathname)) return;
    const previous = sources.get(url.pathname);
    // A navigation link or script fallback must not replace a readable name.
    if (previous && (!rawName || previous.meta.raw_name)) return;
    const name = rawName || url.pathname;
    sources.set(url.pathname, {
      retailer: "ramstore",
      external_id: url.pathname,
      name,
      url: url.href,
      scope: "branch",
      meta: {
        ...(rawName ? { raw_name: rawName } : {}),
        outlet_type: /(?:^|\s)(?:HOME|ХОМЕ)(?:\s|$)/iu.test(rawName)
          ? "home"
          : rawName
            ? "supermarket"
            : "unknown",
        discovery_url: base,
      },
    });
  };
  for (const anchor of $("a[href]").toArray())
    add($(anchor).attr("href")!, ramstoreCardName($, anchor));
  for (const button of $("[onclick]").toArray()) {
    const match = $(button)
      .attr("onclick")!
      .match(/location\.href\s*=\s*(['"])(.*?)\1/);
    if (match) add(match[2], ramstoreCardName($, button));
  }
  // Retain discovery of legacy script-only links, with lower metadata priority.
  for (const match of html.matchAll(
    /(?:href|location\.href)\s*=\s*['"]([^'"]*\/marketi\/[^'"]+)['"]/g,
  ))
    add(match[1], "");
  return [...sources.values()];
}

export function discoverSparCatalogs(
  html: string,
  base: string,
): DiscoveredSource[] {
  const $ = load(html);
  const sources = new Map<string, DiscoveredSource>();
  for (const anchor of $("a[href]").toArray()) {
    const url = catalogUrl($(anchor).attr("href")!, base);
    const match = url?.pathname.match(/^\/pricelist\/(\d+)$/);
    if (!url || !match) continue;
    const card = $(anchor)
      .parents("div,article,li")
      .filter((_, parent) => $(parent).find("h3").length === 1)
      .first();
    const rawName = text(card.find("h3").first().text());
    if (!rawName) continue;
    const rawCity = text(card.find('[class*="__location"]').first().text());
    const storeNumber = rawName.match(/\bM\.\s*(\d+)\b/i)?.[1];
    sources.set(match[1], {
      retailer: "spar",
      external_id: match[1],
      name: sparDisplayText(rawName),
      url: url.href,
      scope: "branch",
      meta: {
        raw_name: rawName,
        raw_city: rawCity,
        city: sparDisplayText(rawCity),
        ...(storeNumber ? { store_number: storeNumber } : {}),
        outlet_type: "supermarket",
        name_normalization_version: NAME_NORMALIZATION_VERSION,
        discovery_url: base,
      },
    });
  }
  return [...sources.values()];
}
