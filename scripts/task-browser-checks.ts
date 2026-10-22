import assert from "node:assert/strict";
import type { Page, Route } from "playwright";

// Intercept every task mutation: these checks must never launch real work.
export async function verifyTaskLaunches(page: Page) {
  const mutations = /\/api\/(ingestion|matching|retry)$/;
  const submissions: { path: string; body: unknown }[] = [];
  let fail = false;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  let captured: (() => void) | undefined;
  const interceptTask = async (route: Route) => {
    assert.equal(route.request().method(), "POST");
    submissions.push({
      path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    });
    captured?.();
    if (gate) await gate;
    await route.fulfill({
      status: fail ? 500 : 200,
      json: fail
        ? { ok: false, errors: [{ message: "Test request was not accepted" }] }
        : { ok: true, data: { id: "00000000-0000-4000-8000-000000000001" } },
    });
  };
  const choose = async (label: string, option: string | RegExp) => {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page
      .getByRole("option", { name: option, exact: typeof option === "string" })
      .click();
  };
  const dialog = page.getByRole("alertdialog");
  const screenshot = async (name: string) => {
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await page.screenshot({ path: `.data/${name}.png` });
  };
  const cancel = async () => {
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  };
  const confirm = async (label: string) => {
    await dialog.getByRole("button", { name: label, exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  };
  const dismissNotice = async () => {
    await page.getByRole("button", { name: "Dismiss notification" }).click();
  };
  await page.route(mutations, interceptTask);
  try {
    await page.getByRole("button", { name: "Products", exact: true }).click();
    assert.equal(
      await page
        .getByRole("button", { name: "Find product matches", exact: true })
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "Data updates", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector('[aria-busy="true"]'),
    );
    assert.equal(
      await page.getByRole("button", { name: /Import all stores/ }).count(),
      0,
    );
    const reloadResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/operations" &&
        url.searchParams.get("view") === "runs"
      );
    });
    const reload = page.getByRole("button", {
      name: "Reload view",
      exact: true,
    });
    await reload.hover();
    await page
      .getByRole("tooltip")
      .getByText(
        "Reload displayed data. No imports or matching tasks are started.",
      )
      .waitFor();
    await reload.click();
    assert.equal((await reloadResponse).request().method(), "GET");
    assert.equal(
      submissions.length,
      0,
      "Reloading a view must not launch work",
    );

    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Review import", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Review matching", exact: true })
        .isDisabled(),
      true,
    );
    await screenshot("tasks");
    await page.reload();
    await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();

    await choose("Store to import", "KAM");
    await page
      .getByRole("button", { name: "Review import", exact: true })
      .click();
    await dialog.getByText("KAM", { exact: true }).waitFor();
    await cancel();
    await choose("Store to import", /All enabled stores/);
    await page
      .getByRole("button", { name: "Review import", exact: true })
      .click();
    assert.match(await dialog.innerText(), /All \d+ enabled stores/);
    await cancel();
    await choose("Products to re-check", "All catalogs");
    await page
      .getByRole("button", { name: "Review matching", exact: true })
      .click();
    await dialog
      .getByText("All catalogs across all stores", { exact: true })
      .waitFor();
    await screenshot("task-review");
    await cancel();
    assert.equal(
      submissions.length,
      0,
      "Choosing scopes, reviewing, and canceling must not submit work",
    );

    await choose("Products to re-check", "One catalog");
    assert.equal(
      await page
        .getByRole("button", { name: "Review matching", exact: true })
        .isDisabled(),
      true,
    );
    const firstPage = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/operations" &&
        url.searchParams.get("view") === "sources" &&
        url.searchParams.get("retailer") === "kam" &&
        url.searchParams.get("page") === "1"
      );
    });
    await choose("Catalog store", "KAM");
    const catalogs = (await (await firstPage).json()).data;
    await page.waitForFunction(
      () =>
        !document
          .getElementById("task-match-catalog")
          ?.hasAttribute("disabled"),
    );
    await page
      .getByRole("combobox", { name: "Catalog to re-check", exact: true })
      .click();
    assert.equal(
      await page.getByRole("option").count(),
      catalogs.total,
      "Catalog selection must include every page",
    );
    await page.getByRole("option").first().click();
    await page
      .getByRole("button", { name: "Review matching", exact: true })
      .click();
    await dialog
      .getByText(`KAM · ${catalogs.rows[0].name}`, { exact: true })
      .waitFor();
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstSubmission = new Promise<void>((resolve) => {
      captured = resolve;
    });
    await dialog
      .getByRole("button", { name: "Start matching", exact: true })
      .evaluate((button) => {
        if (!(button instanceof HTMLButtonElement))
          throw new Error("Expected a button");
        button.click();
        button.click();
      });
    await firstSubmission;
    await dialog
      .getByRole("button", { name: "Preparing task…", exact: true })
      .waitFor();
    assert.equal(
      submissions.length,
      1,
      "Repeated clicks must submit just once",
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Cancel", exact: true })
        .isDisabled(),
      true,
    );
    assert.deepEqual(submissions[0], {
      path: "/api/matching",
      body: { source_id: catalogs.rows[0].id },
    });
    release!();
    gate = undefined;
    await dialog.waitFor({ state: "hidden" });
    await page.getByText(/Matching accepted/).waitFor();
    await dismissNotice();

    await choose("Products to re-check", "All catalogs");
    await page
      .getByRole("button", { name: "Review matching", exact: true })
      .click();
    await confirm("Start matching");
    assert.deepEqual(submissions[1], {
      path: "/api/matching",
      body: { source_id: null },
    });
    await dismissNotice();
    await choose("Store to import", "KAM");
    await page
      .getByRole("button", { name: "Review import", exact: true })
      .click();
    fail = true;
    await dialog
      .getByRole("button", { name: "Start import", exact: true })
      .click();
    await dialog
      .getByText("Test request was not accepted", { exact: true })
      .waitFor();
    assert.equal(
      await page.getByText(/Import accepted/).count(),
      0,
      "A rejected request must not display success",
    );
    await cancel();
    fail = false;
    await page
      .getByRole("button", { name: "Review import", exact: true })
      .click();
    assert.equal(
      await dialog
        .getByText("Test request was not accepted", { exact: true })
        .count(),
      0,
    );
    await confirm("Start import");
    assert.deepEqual(submissions[3], {
      path: "/api/ingestion",
      body: { retailer: "kam" },
    });
    await dismissNotice();
    await choose("Store to import", /All enabled stores/);
    await page
      .getByRole("button", { name: "Review import", exact: true })
      .click();
    await confirm("Start import");
    assert.deepEqual(submissions[4], {
      path: "/api/ingestion",
      body: { retailer: null },
    });
    await dismissNotice();

    const retryId = "00000000-0000-4000-8000-000000000002";
    const fakeRun = async (route: Route) => {
      if (new URL(route.request().url()).searchParams.get("view") !== "runs")
        return route.continue();
      await route.fulfill({
        json: {
          ok: true,
          data: {
            view: "runs",
            page: 1,
            page_size: 30,
            total: 1,
            total_pages: 1,
            rows: [
              {
                id: retryId,
                kind: "match",
                retailer: "kam",
                source_name: "Test catalog",
                status: "failed",
                error: "Test failure",
                attempts: 1,
              },
            ],
          },
        },
      });
    };
    await page.route("**/api/operations?**", fakeRun);
    await page
      .getByRole("button", { name: "Data updates", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Review retry", exact: true })
      .click();
    await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
    assert.equal(
      submissions.length,
      5,
      "Opening a retry draft must not start it",
    );
    await page
      .getByRole("button", { name: "Review retry", exact: true })
      .click();
    await dialog.getByText("KAM · Test catalog", { exact: true }).waitFor();
    await cancel();
    assert.equal(submissions.length, 5);
    await page
      .getByRole("button", { name: "Review retry", exact: true })
      .click();
    await confirm("Start retry");
    assert.deepEqual(submissions[5], {
      path: "/api/retry",
      body: { id: retryId },
    });
    await page.unroute("**/api/operations?**", fakeRun);
    await dismissNotice();

    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot("mobile-tasks");
    await choose("Products to re-check", "All catalogs");
    await page
      .getByRole("button", { name: "Review matching", exact: true })
      .click();
    const box = await dialog.boundingBox();
    assert.ok(
      box && box.x >= 0 && box.y >= 0 && box.y + box.height <= 844,
      "Review must fit on mobile",
    );
    await screenshot("mobile-task-review");
    await cancel();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    assert.equal(submissions.length, 6);
    console.info(
      "Task launch checks passed: explicit scopes, complete catalog choices, review/cancel, duplicate-click guard, payloads, error feedback, retry drafts, reload-only GET, mobile review. Every task POST was intercepted.",
    );
  } finally {
    release?.();
    await page.unroute(mutations, interceptTask);
  }
}
