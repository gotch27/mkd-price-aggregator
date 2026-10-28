import { expect, it } from "vitest";
import {
  initialNavigation,
  readNavigation,
  navigationKey,
  navigationUrl,
} from "@/app/_components/dashboard/navigation-state";
const initial = initialNavigation("named", "available");
const run = "12345678-1234-4234-8234-123456789012";

it.each(["updates", "logs"])(
  "keeps existing %s links usable inside Observability",
  (tab) => {
    const state = readNavigation(
      new URLSearchParams({
        screen: tab,
        run_id: run,
        correlation_id: "saved-trace",
        retailer: "kam",
        page: "2",
        search: "timeout",
      }),
      initial,
    );
    expect(state).toMatchObject({
      screen: "observability",
      tab,
      run_id: run,
      correlation_id: "saved-trace",
      retailer: "kam",
      page: 2,
      search: "timeout",
    });
  },
);
it.each([
  ["logs", "logs"],
  ["updates", "updates"],
  ["invalid", "updates"],
  ["", "updates"],
])("opens the appropriate canonical tab for %s", (raw, expected) => {
  expect(
    readNavigation(
      new URLSearchParams({ screen: "observability", tab: raw }),
      initial,
    ),
  ).toMatchObject({ screen: "observability", tab: expected });
});
it.each(["overview", "products", "review", "tasks", "settings"])(
  "keeps %s separate and ignores irrelevant tab parameters",
  (screen) => {
    expect(
      readNavigation(new URLSearchParams({ screen, tab: "logs" }), initial),
    ).toMatchObject({ screen, tab: undefined });
  },
);
it.each(["0", "-2", "3.5", "NaN", "Infinity"])(
  "does not send an invalid page %s from a bookmarked URL",
  (page) => {
    expect(
      readNavigation(
        new URLSearchParams({ screen: "observability", page }),
        initial,
      ).page,
    ).toBe(1);
  },
);
it("preserves log filters and a separate memory key from update filters", () => {
  const logs = readNavigation(
    new URLSearchParams({
      screen: "observability",
      tab: "logs",
      level: "warn",
      run_id: run,
      page: "3",
    }),
    initial,
  );
  const updates = readNavigation(
    new URLSearchParams({
      screen: "observability",
      tab: "updates",
      status: "failed",
      kind: "catalog",
      retailer: "spar",
      page: "2",
    }),
    initial,
  );
  expect(logs).toMatchObject({ level: "warn", run_id: run, page: 3 });
  expect(updates).toMatchObject({
    status: "failed",
    kind: "catalog",
    retailer: "spar",
    page: 2,
  });
  expect(navigationKey(logs)).not.toBe(navigationKey(updates));
  const nextPage = { ...logs, page: 1, search: "different" };
  expect(navigationKey(nextPage)).toBe(navigationKey(logs));
});
it("keeps server-supplied display defaults and rejects invalid URL choices", () => {
  const defaults = initialNavigation("all", "all");
  const state = readNavigation(
    new URLSearchParams({
      screen: "missing",
      name_quality: "invalid-choice",
      availability: "invalid-choice",
      run_id: "invalid",
      level: "wrong",
      kind: "wrong",
      status: "wrong",
    }),
    defaults,
  );
  expect(state).toMatchObject({
    screen: "overview",
    name_quality: "all",
    availability: "all",
    run_id: undefined,
    level: undefined,
    kind: undefined,
    status: undefined,
  });
});

it("treats repeated selections as the same URL regardless of property order", () => {
  const current = readNavigation(
    new URLSearchParams({
      screen: "observability",
      tab: "logs",
      level: "warn",
    }),
    initial,
  );
  expect(navigationUrl(current)).toBe(
    navigationUrl({
      ...initial,
      level: "warn",
      tab: "logs",
      screen: "observability",
    }),
  );
  expect(navigationUrl({ ...current, page: 1, run_id: undefined })).toBe(
    navigationUrl(current),
  );
  expect(navigationUrl({ ...current, page: 2 })).not.toBe(
    navigationUrl(current),
  );
  expect(navigationUrl({ ...current, tab: "updates" })).not.toBe(
    navigationUrl(current),
  );
});

it("preserves a brand filter and page in a shareable All products URL", () => {
  const state = readNavigation(
    new URLSearchParams({
      screen: "products",
      mode: "all",
      brand_id: run,
      page: "2",
    }),
    initial,
  );
  expect(state).toMatchObject({
    screen: "products",
    mode: "all",
    brand_id: run,
    page: 2,
  });
  expect(
    readNavigation(new URLSearchParams(navigationUrl(state)), initial),
  ).toEqual(state);
});

it("rejects malformed brand IDs from bookmarked URLs", () => {
  expect(
    readNavigation(
      new URLSearchParams({
        screen: "products",
        mode: "all",
        brand_id: "not-a-brand",
      }),
      initial,
    ).brand_id,
  ).toBeUndefined();
});
