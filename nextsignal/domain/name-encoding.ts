// Punctuation positions from Macedonian JUS I.B1.003 / ISO-IR-147.
// Source: https://www.rfc-editor.org/rfc/rfc1345.txt (JUS_I.B1.003-mac).
// Retailer names mix legacy text, Unicode, and Latin brand/model names. Do not
// decode the entire alphabet: Q/W/X/Y can be genuine brand or model characters.
export const NAME_NORMALIZATION_VERSION = "mk-legacy-v2";
export const legacyMacedonianLetters: Readonly<Record<string, string>> = {
  "@": "Ж",
  "`": "ж",
  "[": "Ш",
  "{": "ш",
  "\\": "Ѓ",
  "|": "ѓ",
  "]": "Ќ",
  "}": "ќ",
  "^": "Ч",
  "~": "ч",
};

const letter = /\p{L}/u;
const wordCharacter = /[\p{L}\p{N}]/u;
const legacySymbol = /[@`[\]{}\\|^~]/;

export function decodeLegacyMacedonian(value: string): string {
  if (!legacySymbol.test(value)) return value;
  const addresses = [
    ...value.matchAll(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu),
  ].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  // Balanced brackets at word boundaries are ordinary packaging annotations.
  // Internal glyphs such as [E]ER (ШЕЌЕР) are not bracket annotations.
  const annotations: { start: number; end: number }[] = [];
  for (const match of value.matchAll(/\[[^\[\]]*\]|\{[^{}]*\}/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (
      !wordCharacter.test(value[start - 1] ?? "") &&
      !wordCharacter.test(value[end] ?? "")
    )
      annotations.push({ start, end });
  }
  return value.replace(/[@`[\]{}\\|^~]/g, (symbol, offset: number) => {
    if (
      annotations.some(
        ({ start, end }) => offset === start || offset === end - 1,
      ) ||
      addresses.some(({ start, end }) => offset >= start && offset < end)
    )
      return symbol;
    // Leave standalone punctuation, dimensions (10^3), and separators alone.
    if (
      !letter.test(value[offset - 1] ?? "") &&
      !letter.test(value[offset + 1] ?? "")
    )
      return symbol;
    return legacyMacedonianLetters[symbol];
  });
}
