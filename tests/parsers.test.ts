import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseTable,
  parseSpar,
  parseKam,
  parseWoo,
  selectedBranches,
  publishedCounts,
  pagination,
} from "@/nextsignal/services/parsers";
import type { CatalogRow, Retailer } from "@/nextsignal/domain/types";
const fixtures = [
  "kam",
  "ramstore",
  "stokomak",
  "spar",
  "zito",
  "vero",
  "zur",
  "dim",
  "reptil",
] as Retailer[];
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
it("reads KAM availability from each page header and never appends wrapped description text to the flag", () => {
  const line = (fields: [number, string][]) => {
    const chars = Array.from({ length: 190 }, () => " ");
    for (const [at, text] of fields)
      for (let i = 0; i < text.length; i++) chars[at + i] = text[i];
    return chars.join("").trimEnd();
  };
  const header = (available: number, regular: number) =>
    line([
      [0, "Назив на"],
      [21, "Продажна"],
      [39, "Единична"],
      [59, "Опис на"],
      [available, "Достапност"],
      [regular, "Редовна"],
    ]);
  const sub = line([
    [109, "Цена со"],
    [125, "Вид на"],
    [145, "Времетраење"],
  ]);
  const first = line([
    [0, "ЧОРАПИ"],
    [24, "40ден."],
    [60, "Опис"],
    [89, "Да"],
    [95, "40ден."],
  ]);
  const continuation = line([
    [3, "3/1 СПИРИТ"],
    [79, "38"],
  ]);
  const second = line([
    [0, "ГАЈБА"],
    [24, "40ден."],
    [60, "Опис"],
    [75, "Да"],
    [86, "40ден."],
  ]);
  const text = [
    header(79, 93),
    sub,
    first,
    continuation,
    "\f",
    header(70, 84),
    sub,
    second,
  ].join("\n");
  expect(parseKam(text).map((r) => r.available)).toEqual([true, true]);
  expect(parseKam(text.replaceAll("Да", "/ ")).map((r) => r.available)).toEqual(
    [null, null],
  );
});
describe("captured live retailer records", () => {
  it("retains PDF products whose availability is unknown", () => {
    const fixture = JSON.parse(
      readFileSync("tests/fixtures/live/kam.json", "utf8"),
    );
    const rows = parseKam(
      fixture.pdf_excerpt.replace(/(?<=\s)(Да|Не)(?=\s|$)/g, "/ "),
    );
    expect(rows).toHaveLength(11);
    expect(rows.every((row) => row.available === null)).toBe(true);
    expect(rows[0].price).toBe("25.00");
  });
  for (const retailer of fixtures)
    it(`${retailer} preserves names, prices and nullable availability`, () => {
      const fixture = JSON.parse(
        readFileSync(`tests/fixtures/live/${retailer}.json`, "utf8"),
      );
      const rows = fixture.rows as CatalogRow[];
      expect(rows.length).toBeGreaterThan(0);
      let parsed: CatalogRow[];
      if (retailer === "spar") parsed = parseSpar(rows.map((r) => r.raw));
      else if (retailer === "kam") {
        const parsed = parseKam(fixture.pdf_excerpt);
        expect(parsed[0].name).toBe("ЛАЈБИЦИ СЛИБО ДИЕТ 250Г");
        expect(parsed[0].price).toBe("25.00");
        expect(parsed[1].unit_price).toBeNull();
        return;
      } else if (retailer === "reptil") {
        parsed = parseWoo(rows.map((r) => r.raw));
      } else
        parsed = parseTable(
          rows
            .map(
              (r) =>
                `<tr>${(r.raw.cells as string[]).map((c) => `<td>${escape(c)}</td>`).join("")}</tr>`,
            )
            .join(""),
          retailer,
          "reject",
        );
      expect(parsed.map((r) => [r.name, r.price, r.available])).toEqual(
        rows.map((r) => [r.name, r.price, r.available]),
      );
    });
  it("extracts prices from AJAX fragments without dropping tr elements", () =>
    expect(
      parseTable(
        "<tr><td>000123</td><td>МЛЕКО 1Л</td><td>65.00</td><td></td><td>/</td><td>Да</td><td>70.00</td><td>65,00 Попуст: 7%</td><td>Акција</td><td>Утре</td></tr>",
        "zur",
        "reject",
      )[0],
    ).toMatchObject({
      key: "000123",
      price: "65.00",
      regular_price: "70.00",
      promo_price: "65.00",
    }));
  it("rejects broken selling prices instead of silently dropping products", () =>
    expect(() =>
      parseTable(
        "<tr><td>Milk</td><td>broken</td><td>1L</td><td>Dairy</td><td>Да</td><td>65</td></tr>",
        "ramstore",
        "reject",
      ),
    ).toThrow());
  it("preserves unknown availability", () =>
    expect(
      parseTable(
        "<tr><td>Milk</td><td>65</td><td>1L</td><td>Dairy</td><td>?</td><td>65</td></tr>",
        "ramstore",
        "reject",
      )[0].available,
    ).toBeNull());
  it("discovers only nonempty branch identifiers", () =>
    expect(
      selectedBranches(
        '<select name="org"><option value="">Choose</option><option value="2">Велес</option></select>',
      ),
    ).toEqual([{ id: "2", name: "Велес" }]));
});

it("preserves unparseable prices as unknown when explicitly configured", () => {
  expect(
    parseTable(
      "<tr><td>Missing price</td><td>unknown</td><td></td><td>Gift</td><td>Да</td><td></td></tr>",
      "ramstore",
      "preserve_unknown",
    )[0],
  ).toMatchObject({ name: "Missing price", price: null });
});
it("accepts a published header-only KAM PDF for independent empty confirmation", () => {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/live/kam.json", "utf8"),
  );
  const header = fixture.pdf_excerpt.split("Попуст(%)")[0] + "Попуст(%)\n\f";
  expect(parseKam(header)).toEqual([]);
  expect(() => parseKam(header + "Unexpected unreadable product line")).toThrow(
    "no readable",
  );
});
it("checks published platform counts and preserves branch pagination parameters", () => {
  const html = readFileSync("tests/fixtures/platform-pagination.html", "utf8");
  expect(publishedCounts(html)).toEqual({ from: 1, to: 100, total: 5927 });
  const pages = pagination(html, "https://zito.proverkanaceni.mk/");
  expect(pages.map((page) => page.searchParams.get("page"))).toEqual([
    "1",
    "2",
    "60",
  ]);
  expect(pages.every((page) => page.searchParams.get("org") === "62")).toBe(
    true,
  );
  expect(() => publishedCounts("<div>Changed page</div>")).toThrow(
    "counts are missing",
  );
});
