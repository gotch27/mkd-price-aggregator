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
