import assert from "node:assert/strict";
import type { Page, Route } from "playwright";

// These UI checks exercise reviewed requests with mocked acceptance. They never
// save operational settings or send a task mutation to the application server.
export async function verifyTaskLaunches(page: Page) {
  const mutations =
    /\/api\/(?:tasks(?:\/control)?|ingestion|categorization|matching)(?:\?.*)?$/;
  const submissions: { path: string; body: Record<string, unknown> }[] = [];
  const interceptTask = async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    submissions.push({
      path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    });
    await route.fulfill({
      json: { ok: true, data: { id: "00000000-0000-4000-8000-000000000001" } },
    });
  };
  const settingsPattern = /\/api\/task-settings$/;
  const readSettings = async (route: Route) => {
    assert.equal(
      route.request().method(),
      "GET",
      "Smoke must never save settings",
    );
    const response = await route.fetch();
    const result = await response.json();
    assert.equal(result.ok, true);
    result.data.policy = {
      ...result.data.policy,
      paused: false,
      imports: "manual",
      categorization: "manual",
      matching: "manual",
      ai_enabled: false,
      default_product_limit: 50,
    };
    await route.fulfill({ json: result });
  };
  const choose = async (label: string, option: string) => {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  const dialog = page.getByRole("alertdialog");
  await page.route(mutations, interceptTask);
  await page.route(settingsPattern, readSettings);
  try {
    await page.getByRole("button", { name: "Run Tasks", exact: true }).click();
    await page
      .getByRole("heading", { name: "Run Tasks", exact: true })
      .waitFor();
    for (const [label, kind] of [
      ["Discover catalogs", "discover"],
      ["Import prices", "import"],
      ["Run matching", "match"],
    ] as const) {
      await page.getByRole("tab", { name: new RegExp(`^${label}`) }).click();
      await choose("Store", "KAM");
      const count = submissions.length;
      await page
        .getByRole("button", { name: "Review task", exact: true })
        .click();
      await dialog
        .getByRole("heading", { name: `${label}?`, exact: true })
        .waitFor();
      assert.equal(
        submissions.length,
        count,
        "Reviewing a task must not start work",
      );
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(submissions.length, count, "Cancel must not submit work");
      await page
        .getByRole("button", { name: "Review task", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Start task", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(submissions.length, count + 1);
      assert.deepEqual(
        {
          path: submissions.at(-1)!.path,
          kind: submissions.at(-1)!.body.kind,
          retailers: submissions.at(-1)!.body.retailers,
          use_ai: submissions.at(-1)!.body.use_ai,
          product_limit: submissions.at(-1)!.body.product_limit,
        },
        {
          path: "/api/tasks",
          kind,
          retailers: ["kam"],
          use_ai: false,
          product_limit: kind === "match" ? 50 : null,
        },
      );
      assert.equal(typeof submissions.at(-1)!.body.idempotency_key, "string");
    }
    await page.getByRole("tab", { name: /^Categorize products/ }).click();
    assert.equal(
      await page
        .getByRole("button", { name: "Review task", exact: true })
        .isDisabled(),
      true,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await choose("Task", "Run matching");
    await page
      .getByRole("button", { name: "Review task", exact: true })
      .click();
    await dialog.getByText(/50 unique store products/).waitFor();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.screenshot({ path: ".data/mobile-task-review.png" });
  } finally {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.unroute(mutations, interceptTask);
    await page.unroute(settingsPattern, readSettings);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
  }
}
