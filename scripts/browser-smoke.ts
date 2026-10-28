import { chromium, type Page } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { settings } from "@/nextsignal/config";
import { verifyTaskLaunches } from "@/scripts/task-browser-checks";
const testing = JSON.parse(await readFile("config/testing.json", "utf8"));
assert.ok(
  Number.isSafeInteger(testing.dashboard_response_budget_ms) &&
    testing.dashboard_response_budget_ms > 0,
);
let activePage: Page | undefined;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  activePage = page;
  // Fail closed for every write, including future task/settings endpoints. The
  // scoped task helper registers mock acceptance above this catch-all guard.
  const unexpectedWrites: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (
      !["GET", "HEAD"].includes(request.method()) &&
      path !== "/api/auth/login"
    ) {
      unexpectedWrites.push(`${request.method()} ${path}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  page.setDefaultTimeout(testing.timeout_ms);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const responseFor = (
    view: string,
    extra: (p: URLSearchParams) => boolean = () => true,
  ) =>
    page.waitForResponse((r) => {
      const u = new URL(r.url());
      return (
        u.pathname === "/api/operations" &&
        u.searchParams.get("view") === view &&
        extra(u.searchParams)
      );
    });
  async function settled() {
    await page.waitForFunction(
      () => !document.querySelector('[aria-busy="true"]'),
    );
  }
  async function choose(label: string, option: string) {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
  async function screenshot(name: string) {
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {})),
      );
    });
    await page.screenshot({ path: `.data/${name}.png` });
  }
  await mkdir(".data", { recursive: true });
  await page.goto(testing.web_url);
  await page
    .getByRole("textbox", { name: "Username" })
    .fill(settings.auth.username);
  await page
    .getByLabel("Password", { exact: true })
    .fill(settings.auth.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Catalog coverage", { exact: true }).waitFor();
  await verifyTaskLaunches(page);
  assert.equal(await page.locator("pre").count(), 0);
  await screenshot("dashboard");
  await page.getByRole("button", { name: "Products", exact: true }).click();
  await page.getByRole("button", { name: "Browse KAM catalogs" }).waitFor();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".store-logo img")).every(
      (img) => (img as HTMLImageElement).complete,
    ),
  );
  assert.equal(
    await page.locator(".store-card img").count(),
    9,
    "Every store should have a logo",
  );
  await screenshot("stores");
  const catalogs = responseFor("sources", (p) => p.get("retailer") === "kam");
  await page.getByRole("button", { name: "Browse KAM catalogs" }).click();
  assert.equal((await catalogs).ok(), true);
  await settled();
  await screenshot("catalogs");
  const catalogProducts = responseFor("products", (p) => !!p.get("source_id"));
  await page
    .getByRole("button", { name: "Open catalog", exact: true })
    .first()
    .click();
  const scoped = await (await catalogProducts).json();
  assert.ok(
    scoped.data.rows.every(
      (r: Record<string, unknown>) =>
        r.retailer === "kam" && typeof r.catalog_name === "string",
    ),
  );
  await settled();
  assert.doesNotMatch(await page.locator("tbody").innerText(), /undefined/);
  await screenshot("products");
  await page.locator(".workspace-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const before = await page.locator(".pagination").boundingBox();
  const next = responseFor("products", (p) => p.get("page") === "2");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  assert.equal((await (await next).json()).data.page, 2);
  await settled();
  const after = await page.locator(".pagination").boundingBox();
  assert.ok(
    before && after && Math.abs(before.y - after.y) < 2,
    "Pagination must not jump while changing pages",
  );
  await page
    .getByRole("button", { name: "Details", exact: true })
    .first()
    .click();
  const productDialog = page.getByRole("dialog", {
    name: "Product details",
    exact: true,
  });
  await productDialog.waitFor();
  await productDialog
    .getByRole("tab", { name: "Store products", exact: true })
    .waitFor();
  assert.equal(await productDialog.locator("pre").count(), 0);
  await productDialog
    .getByRole("tab", { name: "Catalog prices", exact: true })
    .click();
  await productDialog
    .getByRole("columnheader", { name: "Store / catalog", exact: true })
    .waitFor();
  await productDialog
    .getByRole("tab", { name: "Matching", exact: true })
    .click();
  await productDialog
    .getByText("Why these products match", { exact: true })
    .waitFor();
  await screenshot("product-details");
  await productDialog
    .getByRole("button", { name: "Close", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Page 2", exact: true })
      .getAttribute("aria-current"),
    "page",
  );
  const reloaded = responseFor(
    "products",
    (p) => p.get("page") === "2" && !!p.get("source_id"),
  );
  await page.reload();
  await reloaded;
  await settled();
  assert.equal(
    await page
      .getByRole("button", { name: "Page 2", exact: true })
      .getAttribute("aria-current"),
    "page",
  );
  const all = responseFor("universal");
  const start = performance.now();
  await page.getByRole("radio", { name: "All products", exact: true }).click();
  assert.equal((await all).ok(), true);
  await settled();
  assert.ok(
    performance.now() - start < testing.dashboard_response_budget_ms,
    "Universal product browsing exceeded the configured response budget",
  );
  const matched = responseFor(
    "universal",
    (p) => p.get("match_filter") === "matched",
  );
  await choose("Matching status", "Matched across stores");
  const matchedResult = await (await matched).json();
  await settled();
  assert.ok(
    matchedResult.data.rows.every(
      (r: Record<string, unknown>) => Number(r.connected_retailers) > 1,
    ),
  );
  await screenshot("universal-products");
  await page
    .getByRole("button", { name: "Details", exact: true })
    .first()
    .click();
  await productDialog
    .getByRole("tab", { name: "Matching", exact: true })
    .waitFor();
  await productDialog
    .getByRole("tab", { name: "Matching", exact: true })
    .click();
  assert.equal(await productDialog.locator("pre").count(), 0);
  const history = productDialog
    .locator('[data-slot="accordion-trigger"]')
    .first();
  if (await history.count()) await history.click();
  await screenshot("matching");
  await productDialog
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const updates = responseFor("runs");
  await page
    .getByRole("button", { name: "Observability", exact: true })
    .click();
  await page.getByRole("tab", { name: "Data updates", exact: true }).click();
  assert.equal((await updates).ok(), true);
  await settled();
  await page
    .getByRole("button", { name: "Details", exact: true })
    .first()
    .click();
  const updateDialog = page.getByRole("dialog", {
    name: "Update details",
    exact: true,
  });
  await updateDialog.waitFor();
  assert.equal(await updateDialog.locator("pre").count(), 0);
  const logs = responseFor("logs", (p) => !!p.get("run_id"));
  await updateDialog.getByRole("button", { name: "View related logs" }).click();
  assert.equal((await logs).ok(), true);
  await settled();
  await updateDialog.waitFor({ state: "hidden" });
  await screenshot("logs");
  if (
    await page.getByRole("button", { name: "Details", exact: true }).count()
  ) {
    await page
      .getByRole("button", { name: "Details", exact: true })
      .first()
      .click();
    const logDialog = page.getByRole("dialog", {
      name: "Log details",
      exact: true,
    });
    await logDialog.getByText("Log data (JSON)", { exact: true }).waitFor();
    await screenshot("log-details");
    await logDialog.getByRole("button", { name: "Close", exact: true }).click();
    await logDialog.waitFor({ state: "hidden" });
  }
  assert.equal(
    await page.locator('.log-legend [data-slot="badge"]').count(),
    4,
  );
  // A delayed response from a previous screen must never overwrite Logs.
  await page.getByRole("button", { name: "Products", exact: true }).click();
  await settled();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const intercepted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route("**/api/operations?**", async (route) => {
    const p = new URL(route.request().url()).searchParams;
    if (p.get("view") === "universal" && p.get("search") === "stale-test") {
      entered();
      await gate;
      try {
        await route.fulfill({
          json: {
            ok: true,
            data: {
              view: "universal",
              rows: [{ id: "stale", name: "STALE PRODUCT MUST NOT RENDER" }],
              page: 1,
              page_size: 30,
              total: 1,
              total_pages: 1,
            },
          },
        });
      } catch {
        /* Obsolete requests are expected to be cancelled. */
      }
    } else await route.continue();
  });
  await page
    .getByRole("textbox", { name: "Search", exact: true })
    .fill("stale-test");
  await intercepted;
  const currentLogs = responseFor("logs");
  await page
    .getByRole("button", { name: "Observability", exact: true })
    .click();
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await currentLogs;
  release();
  await settled();
  assert.doesNotMatch(
    await page.locator("tbody").innerText(),
    /STALE PRODUCT MUST NOT RENDER|undefined/,
  );
  await page.unroute("**/api/operations?**");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Toggle Sidebar", exact: true })
    .click();
  await page.getByRole("button", { name: "Products", exact: true }).click();
  await settled();
  await screenshot("mobile-empty-products");
  const mobileProducts = responseFor("universal", (p) => !p.get("search"));
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await mobileProducts;
  await settled();
  await screenshot("mobile-products");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "Mobile layout must not overflow horizontally",
  );
  assert.deepEqual(
    unexpectedWrites,
    [],
    "Browser smoke blocked an unexpected mutation",
  );
  assert.deepEqual(errors, []);
  console.info(
    "Browser smoke passed: store/catalog hierarchy, universal products, readable details, matching history, colored logs, stable pagination, URL restoration, stale-response cancellation, mobile navigation, no runtime errors. No imports or matching jobs were triggered.",
  );
} catch (error) {
  if (activePage) {
    await mkdir(".data", { recursive: true });
    await activePage.screenshot({ path: ".data/browser-error.png" });
    console.error(
      (await activePage.locator("body").innerText()).slice(0, 1500),
    );
  }
  throw error;
} finally {
  await browser.close();
}
