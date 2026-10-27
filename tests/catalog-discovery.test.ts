import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  discoverRamstoreCatalogs,
  discoverSparCatalogs,
  discoverVeroCatalogs,
  discoverVeroExcludedCatalogs,
} from "@/nextsignal/services/catalog-discovery";

it("identifies Vero cards despite repaired empty Jumbo anchors", async () => {
  const html = await readFile(
    "tests/fixtures/vero-malformed-discovery.html",
    "utf8",
  );
  const sources = discoverVeroCatalogs(html, "https://pricelist.vero.com.mk/");
  expect(sources).toHaveLength(14);
  expect(sources.every((source) => /^ВЕРО \d+$/.test(source.name))).toBe(true);
  expect(sources.map((source) => source.external_id)).not.toContain("119");
  expect(sources.map((source) => source.external_id)).not.toContain("168");
  expect(sources.map((source) => source.external_id)).not.toContain("124");
  expect(sources[0]).toMatchObject({
    external_id: "89",
    name: "ВЕРО 1",
    url: "https://pricelist.vero.com.mk/89_1.html",
  });
  expect(
    discoverVeroExcludedCatalogs(html, "https://pricelist.vero.com.mk/")
      .map((source) => source.external_id)
      .sort(),
  ).toEqual(["119", "124", "168"]);
});

it("reads the Vero store heading instead of an empty malformed anchor", () => {
  const html = `<table><tr><td><a href="89_1.html"><h1>ВЕРО 1</a></h1><h3>Address</h3></td>
  <td><a href="119_1.html"><h1>ЏАМБО 2</a></h1><h3>Other address</h3></td></tr></table>`;
  const sources = discoverVeroCatalogs(html, "https://pricelist.vero.com.mk/");
  expect(sources).toHaveLength(1);
  expect(sources[0].name).toBe("ВЕРО 1");
});

it("reads Ramstore button cards and does not replace their names with later script fallbacks", () => {
  const html = `<a href="/marketi/ramstore-aerodrom/">Menu</a>
  <div class="store"><h2> РАМСТОРЕ АЕРОДРОМ </h2><p>Адреса: Published address</p>
    <div class="btn_wrap"><button onclick="location.href='https://ramstore.com.mk/marketi/ramstore-aerodrom/';">Види Цени</button></div>
  </div>
  <script>location.href='https://ramstore.com.mk/marketi/ramstore-aerodrom/';</script>`;
  const sources = discoverRamstoreCatalogs(
    html,
    "https://ramstore.com.mk/marketi/",
  );
  expect(sources).toHaveLength(1);
  expect(sources[0]).toMatchObject({
    external_id: "/marketi/ramstore-aerodrom/",
    name: "РАМСТОРЕ АЕРОДРОМ",
    meta: { raw_name: "РАМСТОРЕ АЕРОДРОМ", outlet_type: "supermarket" },
  });
});

it("preserves names from older Ramstore anchor cards and labels HOME separately", () => {
  const sources = discoverRamstoreCatalogs(
    `<div class="store"><h2>РАМСТОРЕ ХОМЕ</h2><a href="/marketi/r-pop-up-store/">Види Цени</a></div>
    <script>location.href='https://ramstore.com.mk/marketi/r-pop-up-store/';</script>
    <div><h3>РАМСТОРЕ ВАРДАР</h3><a href="/marketi/ramstore-vardar/">Види Цени</a></div>`,
    "https://ramstore.com.mk/marketi/",
  );
  expect(sources).toHaveLength(2);
  expect(sources[0]).toMatchObject({
    name: "РАМСТОРЕ ХОМЕ",
    external_id: "/marketi/r-pop-up-store/",
    meta: { outlet_type: "home" },
  });
  expect(sources[1].name).toBe("РАМСТОРЕ ВАРДАР");
});

it("retains script-only Ramstore catalogs without inventing a readable name or outlet type", () => {
  const sources = discoverRamstoreCatalogs(
    `<script>location.href='https://ramstore.com.mk/marketi/unknown/';</script>`,
    "https://ramstore.com.mk/marketi/",
  );
  expect(sources[0]).toMatchObject({
    external_id: "/marketi/unknown/",
    name: "/marketi/unknown/",
    meta: { outlet_type: "unknown" },
  });
});

it("extracts SPAR name, city and store number without changing the catalog ID", () => {
  const html = `<div class="Markets-module-scss-module__Twh8WG__card">
    <div class="Markets-module-scss-module__Twh8WG__market_header"><div class="Markets-module-scss-module__Twh8WG__number">10</div></div>
    <h3>SPAR M.12 Ko~ani Avtobuska</h3>
    <div class="Markets-module-scss-module__Twh8WG__location"><svg></svg> Kocani </div>
    <div><a href="/pricelist/10">Погледни ценовник</a></div>
  </div>`;
  const [source] = discoverSparCatalogs(html, "https://spar.mk/pricelist");
  expect(source).toMatchObject({
    external_id: "10",
    name: "SPAR M.12 Kočani Avtobuska",
    url: "https://spar.mk/pricelist/10",
    meta: {
      raw_name: "SPAR M.12 Ko~ani Avtobuska",
      raw_city: "Kocani",
      city: "Kocani",
      store_number: "12",
    },
  });
  expect(source.name).not.toContain("Погледни ценовник");
  expect(source.name).not.toMatch(/^10/);
});

it("deduplicates SPAR links and ignores navigation links without a store heading", () => {
  const sources = discoverSparCatalogs(
    `<nav><a href="/pricelist/1">Menu</a></nav>
    <article><h3>SPAR M.1 [tip</h3><div class="Markets__location">Stip</div>
    <a href="/pricelist/1">Погледни ценовник</a><a href="/pricelist/1">View</a></article>`,
    "https://spar.mk/pricelist",
  );
  expect(sources).toHaveLength(1);
  expect(sources[0].name).toBe("SPAR M.1 Štip");
});

it("preserves genuine Cyrillic SPAR names while cleaning only legacy glyphs", () => {
  const [source] = discoverSparCatalogs(
    '<article><h3>SPAR M.1 Штип</h3><div class="Markets__location">Штип</div><a href="/pricelist/1">Prices</a></article>',
    "https://spar.mk/pricelist",
  );
  expect(source.name).toBe("SPAR M.1 Штип");
  expect(source.meta.city).toBe("Штип");
});

it("ignores invalid and foreign catalog links instead of changing the source host", () => {
  const html = `<div class="store"><h2>Store</h2><a href="https://other.example/marketi/one/">Other</a>
  <button onclick="location.href='javascript:alert(1)'">Bad</button></div>`;
  expect(
    discoverRamstoreCatalogs(html, "https://ramstore.com.mk/marketi/"),
  ).toEqual([]);
  expect(
    discoverVeroCatalogs(
      '<table><td><h1>ВЕРО 1</h1><a href="https://other.example/89_1.html">Link</a></td></table>',
      "https://pricelist.vero.com.mk/",
    ),
  ).toEqual([]);
});
