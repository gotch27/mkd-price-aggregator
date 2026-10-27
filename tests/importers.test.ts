import { it, expect, vi, afterEach, afterAll } from "vitest";
import * as http from "@/nextsignal/services/http";
import * as time from "@/nextsignal/domain/source-time";
import { retrieve } from "@/nextsignal/services/importers";
import { pool } from "@/nextsignal/services/database";
afterEach(() => vi.restoreAllMocks());
afterAll(() => pool.end());
it("parses document metadata once per page rather than once per product", async () => {
  const html = `<table>${Array.from({ length: 200 }, (_, i) => `<tr><td>Milk ${i}</td><td>65.00</td><td>1L</td><td>Dairy</td><td>Да</td><td>65.00</td></tr>`).join("")}</table>`;
  vi.spyOn(http, "fetchText").mockResolvedValue(html);
  const timestamp = vi
    .spyOn(time, "sourceTimestamp")
    .mockReturnValue("2026-10-20T12:00:00Z");
  const pages = [];
  for await (const page of retrieve(
    {
      id: "source",
      retailer: "ramstore",
      external_id: "test",
      name: "Test",
      url: "https://ramstore.com.mk/marketi/test/",
      scope: "branch",
      meta: {},
    },
    null,
  ))
    pages.push(page);
  expect(pages).toHaveLength(1);
  expect(pages[0].rows).toHaveLength(200);
  expect(timestamp).toHaveBeenCalledTimes(1);
  expect(
    pages[0].rows.every(
      (row) => row.source_updated_at === "2026-10-20T12:00:00Z",
    ),
  ).toBe(true);
});

it.each([
  ["stokomak", 20],
  ["zito", 20],
  ["zito", 100],
] as const)(
  "downloads every %s row with %i-product pages and validates the final short page",
  async (retailer, pageSize) => {
    const { settings } = await import("@/nextsignal/config");
    const requests: URL[] = [];
    vi.spyOn(http, "fetchText").mockImplementation(async (address) => {
      const u = new URL(address);
      requests.push(u);
      const page = Number(u.searchParams.get("page")),
        size = Number(u.searchParams.get("perPage")),
        total = pageSize * 2 + 5;
      const from = (page - 1) * size + 1,
        to = Math.min(page * size, total);
      return `<select name="perPage"><option value="10">10</option><option value="20">20</option><option value="50">50</option><option value="100">100</option></select>
    <p>Прикажи ${from} - ${to} од ${total} артикли</p>
    <table>${Array.from({ length: to - from + 1 }, (_, i) => `<tr><td>Milk ${from + i}</td><td>65.00</td><td>1L</td><td>Dairy</td><td>Да</td><td>65.00</td></tr>`).join("")}</table>
    ${to < total ? `<a href="?org=test&page=${page + 1}&perPage=${size}">Next</a>` : ""}`;
    });
    vi.spyOn(time, "sourceTimestamp").mockReturnValue(null);
    const pages = [];
    for await (const page of retrieve(
      {
        id: "source",
        retailer,
        external_id: "test",
        name: "Test",
        url: settings.sources[retailer].url,
        scope: "branch",
        meta: {},
      },
      null,
      pageSize,
    ))
      pages.push(page);
    expect(pages.map((p) => p.rows.length)).toEqual([pageSize, pageSize, 5]);
    expect(pages.flatMap((p) => p.rows)).toHaveLength(pageSize * 2 + 5);
    expect(pages.at(-1)?.next).toBeNull();
    expect(
      requests.every((u) => u.searchParams.get("perPage") === String(pageSize)),
    ).toBe(true);
  },
);

it("retains an existing snapshot's page size when deployment defaults change", async () => {
  const { settings } = await import("@/nextsignal/config");
  const request = vi
    .spyOn(http, "fetchText")
    .mockResolvedValue(
      `<select name="perPage"><option value="100">100</option><option value="20">20</option></select><p>Прикажи 21 - 21 од 21 артикли</p><table><tr><td>Last product</td><td>65.00</td><td>1L</td><td>Dairy</td><td>Да</td><td>65.00</td></tr></table>`,
    );
  vi.spyOn(time, "sourceTimestamp").mockReturnValue(null);
  const pages = [];
  for await (const p of retrieve(
    {
      id: "source",
      retailer: "zito",
      external_id: "test",
      name: "Test",
      url: settings.sources.zito.url,
      scope: "branch",
      meta: {},
    },
    "2",
    20,
  ))
    pages.push(p);
  expect(new URL(request.mock.calls[0][0]).searchParams.get("perPage")).toBe(
    "20",
  );
  expect(pages).toHaveLength(1);
  expect(pages[0].total).toBe(21);
});

it("retries an unexpectedly empty later page without advancing its saved cursor", async () => {
  const { settings } = await import("@/nextsignal/config");
  const request = vi
    .spyOn(http, "fetchText")
    .mockResolvedValueOnce(
      '<select name="perPage"><option value="20">20</option></select><table></table>',
    )
    .mockResolvedValueOnce(
      '<select name="perPage"><option value="20">20</option></select><p>Прикажи 21 - 21 од 21 артикли</p><table><tr><td>Last product</td><td>65.00</td><td>1L</td><td>Dairy</td><td>Да</td><td>65.00</td></tr></table>',
    );
  const source = {
    id: "source",
    retailer: "zito" as const,
    external_id: "test",
    name: "Test",
    url: settings.sources.zito.url,
    scope: "branch" as const,
    meta: {},
  };
  await expect(retrieve(source, "2", 20).next()).rejects.toMatchObject({
    retryable: true,
    message: "Catalog pagination returned an empty page 2",
  });
  const retry = await retrieve(source, "2", 20).next();
  expect(retry.value).toMatchObject({ total: 21, next: null });
  expect(
    request.mock.calls.map(([address]) =>
      new URL(address).searchParams.get("page"),
    ),
  ).toEqual(["2", "2"]);
});
