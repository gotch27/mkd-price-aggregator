import words from "./product-name-words.json";

// A readable projection, never a source identity or a spelling correction.
// JUS I.B1.003-mac / ISO-IR-147: RFC 1345, character positions 0x40–0x7e.
export const PRODUCT_TEXT_VERSION = "mk-readable-v1";
const latin = "ABVGD\\E@ZYIJKLQMNWOPRST]UFHC^X[";
const cyrillic = "АБВГДЃЕЖЗЅИЈКЛЉМНЊОПРСТЌУФХЦЧЏШ";
const alphabet: Record<string, string> = {};
for (let i = 0; i < latin.length; i++) {
  alphabet[latin[i]] = cyrillic[i];
  alphabet[latin[i].toLowerCase()] = cyrillic[i].toLowerCase();
}
Object.assign(alphabet, { "`": "ж", "{": "ш", "|": "ѓ", "}": "ќ", "~": "ч" });
const encode = Object.fromEntries([...cyrillic].map((c, i) => [c, latin[i]]));
// Exact words attested in clean Unicode catalogs, not inferred product facts.
// See docs/product-name-normalization.md for the reproducible source audit.
const attested = new Set(
  words.map((w) => [...w].map((c) => encode[c] ?? c).join("")),
);
const verbatim =
  /^(?:X{0,3}[SL]|[SML]|ML|CL|DL|L|MG|GR|G|KG|MM|CM|SM|M|W|KW|V|HZ|LED|LCD|USB|HDMI|UV|SPF|PET|PVC|PC|GB|MB|XL|XXL|XXXL)$/i;
const glyph = /[@`\[\]{}\\|^~]/;
const cyrillicLetter = /[\u0400-\u04ff]/;

function decodeToken(token: string) {
  return [...token].map((c) => alphabet[c] ?? c).join("");
}
export function readableProductText(value: string, retailer: string): string {
  const clean = value
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b\ufeff\u00ad]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const protectedRanges = [
    ...clean.matchAll(
      /https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\[[^\[\]]*\]|\{[^{}]*\}/giu,
    ),
  ]
    .filter(
      (m) =>
        !/[\p{L}\p{N}]/u.test(clean[m.index - 1] ?? "") &&
        !/[\p{L}\p{N}]/u.test(clean[m.index + m[0].length] ?? ""),
    )
    .map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      annotation: /^[\[{]/.test(m[0]),
    }));
  for (const match of clean.matchAll(
    /\b(?:[A-Za-z]+[-/.])?[A-Za-z]*\d+[A-Za-z0-9./-]*\b/g,
  ))
    protectedRanges.push({
      start: match.index,
      end: match.index + match[0].length,
      annotation: false,
    });
  return clean.replace(/[\p{L}@`\[\]{}\\|^~]+/gu, (token, offset: number) => {
    const range = protectedRanges.find(
      (r) => offset >= r.start && offset < r.end,
    );
    if (range) {
      // Brackets delimit an annotation; letters inside may still be encoded.
      if (!range.annotation) return token;
      if (offset === range.start && offset + token.length === range.end)
        return glyph.test(token.slice(1, -1))
          ? token[0] +
              readableProductText(token.slice(1, -1), retailer) +
              token.at(-1)
          : token;
      return token;
    }
    if (verbatim.test(token)) return token;
    if (
      ["spar", "vero"].includes(retailer) &&
      !/\d/.test(clean[offset - 1] ?? "") &&
      !/\d/.test(clean[offset + token.length] ?? "")
    ) {
      const spaced = token.replace(
        /(?<=[\p{Lu}@\[\]{}\\|^~])(?:za|so|vo|na|od)(?=[\p{Lu}@\[\]{}\\|^~])/gu,
        " $& ",
      );
      if (spaced !== token) return readableProductText(spaced, retailer);
    }
    if (!/\p{L}/u.test(token))
      return (retailer === "spar" && token === "@") ||
        (["dim", "zur"].includes(retailer) && token === "`")
        ? "Ж"
        : token;
    // Apostrophes in these names are not encoded Ж. The source remains intact.
    if (
      token.includes("`") &&
      (/^[a-z]+`s$/i.test(token) ||
        (!["spar", "vero"].includes(retailer) &&
          /^[a-z]+`[a-z]+$/i.test(token)) ||
        retailer === "ramstore" ||
        (retailer === "vero" && cyrillicLetter.test(token)) ||
        /^(?:Ф`СТ|Д`ОРО|О`КЛОК|Л`ОМБРЕ|А`ЃУП)/iu.test(token))
    )
      return token.replaceAll("`", "'");
    if (glyph.test(token)) {
      const upper = token === token.toUpperCase();
      if (cyrillicLetter.test(token))
        return token.replace(/[@`\[\]{}\\|^~]/g, (c) =>
          upper ? (alphabet[c] ?? c).toUpperCase() : (alphabet[c] ?? c),
        );
      return upper ? decodeToken(token).toUpperCase() : decodeToken(token);
    }
    // Never rewrite article/model codes or units attached to numbers.
    if (
      /\d/.test(clean[offset - 1] ?? "") ||
      /\d/.test(clean[offset + token.length] ?? "")
    )
      return token;
    if (
      (retailer === "spar" || retailer === "vero") &&
      attested.has(token.toUpperCase())
    )
      return decodeToken(token);
    return token;
  });
}

// Extra model fields are useful for decoded letters, not for whitespace or a
// typographic apostrophe. Keep existing classifications reusable in that case.
export function hasReadableTextChange(original: string, readable: string) {
  const formatting = (s: string) =>
    s.normalize("NFC").replace(/[`’]/g, "'").replace(/\s+/g, " ").trim();
  return formatting(original) !== formatting(readable);
}

export function readableProductCategory(value: string, retailer: string) {
  // Most SPAR categories are English/Albanian. A few labels are encoded
  // Macedonian (SIREWE, FILXANI); require an explicit glyph or attested Q/W/X/Y.
  const encoded = (value.match(/[a-z@`\[\]{}\\|^~]+/gi) ?? []).some(
    (token) =>
      (/[qwxy]/i.test(token) && attested.has(token.toUpperCase())) ||
      (glyph.test(token) && readableProductText(token, "unicode") !== token),
  );
  return readableProductText(
    value,
    retailer === "spar" && !encoded ? "unicode" : retailer,
  );
}

export function productTextWarnings(value: string, retailer: string): string[] {
  const warnings: string[] = [];
  if (value.includes("\ufffd"))
    warnings.push(
      "The store supplied unreadable characters. Do not guess missing letters or product details.",
    );
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value))
    warnings.push(
      "A control character was removed from the readable text; the original source is retained.",
    );
  if ((retailer === "dim" || retailer === "zur") && value.includes("?"))
    warnings.push(
      "The source includes question marks. Do not interpret them as a known letter or invent missing details.",
    );
  return warnings;
}
