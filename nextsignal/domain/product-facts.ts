import { normalizeName } from "@/nextsignal/domain/normalize";
import type { LocalMatchingRules } from "@/nextsignal/domain/local-matching";
import type {
  Family,
  FactName,
  Facts,
  ProductInput,
} from "@/nextsignal/domain/matching";

// These are reviewed language rules, not a list of product IDs or accepted
// pairs. Unknown words remain in the exact-name signature and require review.
export const typeVocabulary = [
  "cola",
  "yogurt",
  "milk",
  "cheese",
  "beer",
  "wine",
  "ouzo",
  "diapers",
  "rice",
  "chocolate",
  "candy",
  "bread",
  "apple",
  "pear",
  "tomato",
  "windscreen-fluid",
  "hair-clip",
  "conditioner",
  "shirt",
  "spread",
  "biscuit",
  "instant-coffee",
  "shower-gel",
  "dishwashing-liquid",
  "dishwasher-detergent",
  "plant-drink",
  "pickles",
  "eye-pencil",
  "juice",
  "granola",
  "wafer",
  "bath-wash",
  "dog-food",
  "iced-tea",
  "water",
  "protein-drink",
  "soft-drink",
  "carbonated-drink",
  "butter",
  "cream",
] as const;

const typeAliases: Record<string, string[]> = {
  water: ["water", "voda", "mineralna voda"],
  "protein-drink": ["protein drink", "proteinski napitok", "protein napitok"],
  "soft-drink": ["soft drink", "bezalkoholen pijalok", "pijalak", "pijalok"],
  "carbonated-drink": ["carbonated drink", "gaziran sok"],
  butter: ["butter", "puter"],
  cream: ["cream", "pavlaka"],
  granola: ["granola"],
  wafer: ["wafer", "wafers", "napolitanki"],
  "bath-wash": ["bath wash", "bath foam", "kupka"],
  "dog-food": ["dog food", "hrana za kuche", "hrana za kuce"],
  "iced-tea": ["iced tea", "laden chaj", "leden chaj"],
  spread: [
    "spread",
    "eurokrem",
    "eurocream",
    "kakao krem",
    "chokoladen krem",
    "chocolate cream",
    "cream spread",
  ],
  biscuit: [
    "biscuit",
    "biscuits",
    "biskvit",
    "biskviti",
    "keks",
    "plazma keks",
  ],
  "instant-coffee": [
    "instant coffee",
    "instant kafe",
    "kafe instant",
    "kafe instantno",
    "instantni kafe",
  ],
  "shower-gel": [
    "shower gel",
    "gel za tushiranje",
    "gel za tush",
    "gelovi za tushiranje",
  ],
  "dishwashing-liquid": [
    "washing up liquid",
    "dishwashing liquid",
    "detergent za sadovi",
    "sredstvo za sadovi",
    "sred za sadovi",
    "detergent za rachno mienje sadovi",
  ],
  "plant-drink": [
    "plant drink",
    "organic soy drink",
    "soja napitok",
    "napitok od soja",
  ],
  "eye-pencil": [
    "eye pencil",
    "pencil for eye",
    "pencil for eye normal",
    "moliv za ochi",
    "pink moliv",
  ],
  juice: ["juice", "sok", "negaziran sok", "ovoshen sok"],
  pickles: ["pickles", "cornichons", "kornishoni"],
};
export const word = (text: string, pattern: string) =>
  new RegExp(`(?:^| )(?:${pattern})(?= |$)`, "iu").test(text);
export const factText = (value: string) =>
  normalizeName(value)
    .replace(/(?<=[a-z])[.!?]+/g, " ")
    .replace(/([a-z])(?=\d{4,})/g, "$1 ");

export function canonicalBrand(value: string, rules: LocalMatchingRules) {
  const text = normalizeName(value);
  return (
    rules.brands.find((b) =>
      [b.canonical, ...b.aliases].some((a) => normalizeName(a) === text),
    )?.canonical ?? text
  );
}
export function canonicalType(value: string): string | null {
  if ((typeVocabulary as readonly string[]).includes(value)) return value;
  const text = normalizeName(value);
  return (
    Object.entries(typeAliases).find(([, aliases]) =>
      aliases.some((a) => normalizeName(a) === text),
    )?.[0] ?? null
  );
}
export function canonicalFactValue(
  field: FactName,
  value: string,
  rules: LocalMatchingRules,
): string {
  if (field === "brand") return canonicalBrand(value, rules);
  if (field === "type") return canonicalType(value) ?? normalizeName(value);
  if (field === "model" || field === "shade")
    return value.normalize("NFKC").toUpperCase().trim().replace(/\s+/g, " ");
  if (field === "unit") return normalizeName(value).replace(/^kgr$/, "kg");
  return normalizeName(value);
}

export function productType(
  name: string,
): { type: string; family: Family } | null {
  const t = factText(name);
  if (word(t, "hrana za ku(?:ch|c)e|dog food"))
    return { type: "dog-food", family: "pet" };
  if (word(t, "laden chaj|leden chaj|iced tea"))
    return { type: "iced-tea", family: "soft_drinks" };
  if (word(t, "granola")) return { type: "granola", family: "other_food" };
  if (word(t, "napolitanki|wafers?"))
    return { type: "wafer", family: "other_food" };
  if (word(t, "kupka|bath wash|bath foam"))
    return { type: "bath-wash", family: "personal_care" };
  if (
    word(t, "sok|juice") &&
    !word(t, "coca cola|koka kola|pepsi|fanta|schweppes|bonboni|candy")
  )
    return { type: "juice", family: "soft_drinks" };
  // Product words take precedence over ingredient/fragrance words and over
  // unreliable translated categories (e.g. apple-scented Fairy is not fruit).
  if (
    word(t, "tablet[ia]?|tableti|kapsuli|capsules?") &&
    word(t, "feri|fairy|finish")
  )
    return { type: "dishwasher-detergent", family: "cleaning" };
  if (word(t, "gel za tush(?:iranje)?|shower gel|gelovi za tushiranje"))
    return { type: "shower-gel", family: "personal_care" };
  if (
    word(t, "feri|fairy") &&
    !word(t, "b u|bi ju|secret|sikret") &&
    word(
      t,
      "sadovi|dishwashing|washing|limon|lemon|jabolko|apple|kalinka|detergent|sredstvo|max power|maks pover",
    )
  )
    return { type: "dishwashing-liquid", family: "cleaning" };
  if (word(t, "kornishoni|cornichons|pickles"))
    return { type: "pickles", family: "other_food" };
  if (word(t, "moliv|pencil") && word(t, "malena|ochi|eye|pink"))
    return { type: "eye-pencil", family: "personal_care" };
  if (
    word(t, "nescafe|neskafe|instant kafe|instant coffee") &&
    !word(t, "kapuchino|cappuccino|3vo1|3in1|3 vo 1|2vo1|2 vo 1")
  )
    return { type: "instant-coffee", family: "other_food" };
  if (word(t, "soja|soy|ovesen|oat|orizov") && word(t, "napitok|drink"))
    return { type: "plant-drink", family: "soft_drinks" };
  if (word(t, "bisk|biskvit[i]?|biscuits?|keks|medenjaci|medewaci|honey cake"))
    return { type: "biscuit", family: "other_food" };
  if (
    word(
      t,
      "eurokrem|eurocream|kakao krem|choko krem|krem chokol|chokoladen krem|chocolate cream",
    ) ||
    (word(t, "nutella|nutela") && word(t, "krem|spread"))
  )
    return { type: "spread", family: "other_food" };
  if (word(t, "hepi dej|happy day") && !word(t, "bonboni|candy"))
    return { type: "juice", family: "soft_drinks" };
  return null;
}

export function descriptiveFacts(
  input: ProductInput,
  existing: Facts,
  rules: LocalMatchingRules,
): Facts {
  const facts: Facts = {},
    text = factText(input.name),
    type = existing.type?.value;
  const put = (field: FactName, value: string, quote = input.name) => {
    facts[field] = {
      value: canonicalFactValue(field, value, rules),
      quote,
      source: "name",
      method: "rule",
    };
  };
  const ranges: [string, string][] = [
    ["creme-care", "krem kear|krem ker|creme care"],
    ["creme-soft", "krem soft|creme soft"],
    ["max-power", "max power|maks pover|maks pauer"],
    ["family", "femili|family"],
    ["mini-mini", "mini mini"],
  ];
  for (const [range, pattern] of ranges)
    if (word(text, pattern)) {
      put("range", range);
      break;
    }
  if (type === "eye-pencil") {
    if (word(text, "pink")) put("range", "pink");
    const shade = input.name.match(/(?:^|\s)(\d{3,4})\s*$/u);
    if (shade) put("shade", shade[1], shade[0]);
  }
  if (
    [
      "juice",
      "plant-drink",
      "biscuit",
      "dishwashing-liquid",
      "cola",
      "granola",
      "wafer",
      "iced-tea",
      "dog-food",
    ].includes(type ?? "")
  ) {
    const flavours: [string, string][] = [
      ["apricot", "kajsija|apricot"],
      ["strawberry", "jagoda|strawberry"],
      ["vanilla", "vanila|vanilla"],
      ["cocoa", "kakao|cocoa"],
      ["chicken", "pile|pilesh|chicken"],
      ["rice", "oriz"],
      ["lemon", "limon|lemon"],
      ["apple", "jabolko|jabolka|apple"],
      ["blueberry", "borovnica|blueberry"],
      ["orange", "portokal|orange"],
      ["peach", "praska|peach"],
      ["soy", "soja|soy"],
      ["oat", "ovesen|oat"],
      ["rice", "orizov|rice"],
    ];
    const found = [
      ...new Set(
        flavours.filter(([, pattern]) => word(text, pattern)).map(([f]) => f),
      ),
    ].sort();
    if (found.length) put("flavour", found.join("+"));
  }
  if (type === "biscuit") {
    if (word(text, "melen|melena|meleni|mlevena|ground"))
      put("processing", "ground");
    else if (word(text, "cela|celi|whole")) put("processing", "whole");
    if (word(text, "posen|posni|posna|fasting")) put("variant", "fasting");
  }
  if (type === "pickles") {
    const grade = input.name.match(/\d+\s*[-–]\s*\d+\s*(?:цм|cm)/iu);
    if (grade) put("grade", grade[0], grade[0]);
    if (word(text, "ekstra|extra")) put("range", "extra");
  }
  if (["instant-coffee", "spread"].includes(type ?? "")) {
    if (word(text, "kesa|sachet|refill bag|pouch")) put("form", "refill-bag");
    if (word(text, "staklo|tegla|glass jar|jar")) put("form", "glass-jar");
    if (word(text, "limen|limenka|tin|can")) put("form", "can");
  }
  const bonus = input.name.match(/\b(\d+)\s*\+\s*(\d+)\b/u);
  if (bonus && /set|сет|pack|пак/iu.test(input.name))
    put("pack", String(Number(bonus[1]) + Number(bonus[2])), bonus[0]);
  return facts;
}

export const factLabels: Record<FactName, string> = {
  carbonation: "carbonation",
  brand: "brand",
  type: "product type",
  variant: "variant",
  quantity: "amount",
  unit: "sale unit",
  pack: "pack count",
  form: "container",
  gtin: "barcode",
  fat: "fat percentage",
  alcohol: "alcohol percentage",
  model: "model",
  size: "size",
  variety: "variety",
  sale_unit: "sale unit",
  grade: "grade",
  origin: "origin",
  range: "product range",
  flavour: "flavour",
  processing: "whole or ground",
  shade: "shade",
};
