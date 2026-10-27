type PackCount = { value: number; quote: string };

export function hasLengthDimensions(name: string): boolean {
  return /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?\s*(?:[xх×*]\s*\d+(?:[.,]\d+)?\s*)+(?:mm|мм|cm|цм|см|m|м)(?!\p{L})/iu.test(
    name,
  );
}

// A multiplication sign alone does not establish a pack: 35×26 cm describes
// dimensions. Require a complete mass/volume/piece amount, or an explicit
// piece count. Keep the evidence intact for matching details and audit logs.
export function packCount(name: string, retailer?: string): PackCount | null {
  const number = String.raw`\d+(?:[.,]\d+)?`;
  const amountUnit = String.raw`(?:ml|мл|kg|кгр|кг|gr|гр|g|г|l|л|pieces?|pcs?|diapers?|парчиња|парче|ком(?:ада)?|бр)`;
  const pieceUnit = String.raw`(?:pieces?|pcs?|diapers?|парчиња|парче|ком(?:ада)?|бр)`;
  const start = String.raw`(?<![\p{L}\p{N}])(?<!\d[.,])`;
  const unitEnd = String.raw`(?![\p{L}\p{N}])`;
  const countEnd = String.raw`(?![\p{L}\p{N}]|[.,]\d)`;
  // SPAR prints Latin H for Cyrillic Х in explicitly measured multipacks.
  // The following unit check excludes dimensions such as 24H24SM.
  const multiply = retailer === "spar" ? "[xх×*H]" : "[xх×*]";
  const patterns = [
    new RegExp(
      `${start}(?<count>\\d+)\\s*${multiply}\\s*(?<amount>${number})\\s*${amountUnit}${unitEnd}`,
      "giu",
    ),
    new RegExp(
      `${start}(?<amount>${number})\\s*${amountUnit}\\s*${multiply}\\s*(?<count>\\d+)${countEnd}`,
      "giu",
    ),
    new RegExp(`${start}(?<count>\\d+)\\s*\\/\\s*1${countEnd}`, "giu"),
    new RegExp(`${start}(?<count>\\d+)\\s*${pieceUnit}${unitEnd}`, "giu"),
  ];
  const found: PackCount[] = [];
  const spans: { start: number; end: number }[] = [];
  for (const pattern of patterns)
    for (const match of name.matchAll(pattern)) {
      if (
        spans.some(
          (span) => match.index >= span.start && match.index < span.end,
        )
      )
        continue;
      const count = Number(match.groups!.count);
      if (
        Number.isSafeInteger(count) &&
        count > 0 &&
        (!match.groups!.amount ||
          Number(match.groups!.amount.replace(",", ".")) > 0)
      ) {
        found.push({ value: count, quote: match[0] });
        spans.push({ start: match.index, end: match.index + match[0].length });
      }
    }
  // Separate conflicting count statements need interpretation, not a guess
  // based on which pattern happened to run first.
  return found.length && new Set(found.map((item) => item.value)).size === 1
    ? found[0]
    : null;
}
