import type {
  DashboardQuery,
  NameQuality,
} from "@/nextsignal/domain/dashboard";
import type { Screen } from "./types";
export type ObservabilityTab = "updates" | "logs";
export type NavigationState = Omit<DashboardQuery, "view" | "size"> & {
  screen: Screen;
  mode: "stores" | "all";
  source_name?: string;
  tab?: ObservabilityTab;
};
export function initialNavigation(
  nameQuality: NameQuality,
  availability: NonNullable<DashboardQuery["availability"]>,
): NavigationState {
  return {
    screen: "overview",
    mode: "stores",
    search: "",
    page: 1,
    name_quality: nameQuality,
    availability: availability,
    retailer: undefined,
    brand_id: undefined,
    source_id: undefined,
    source_name: undefined,
    run_id: undefined,
    level: undefined,
    match_filter: undefined,
    kind: undefined,
    status: undefined,
    correlation_id: undefined,
  };
}

export function navigationKey(state: Pick<NavigationState, "screen" | "tab">) {
  return state.screen === "observability"
    ? `observability:${state.tab ?? "updates"}`
    : state.screen;
}

export function navigationUrl(state: NavigationState) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state))
    if (value !== undefined && value !== "" && !(key === "page" && value === 1))
      params.set(key, String(value));
  params.sort();
  return `?${params}`;
}

export function readNavigation(
  p: URLSearchParams,
  initial: NavigationState,
): NavigationState {
  const rawScreen = p.get("screen"),
    legacy = rawScreen === "updates" || rawScreen === "logs";
  const screen = legacy ? "observability" : rawScreen;
  const next: NavigationState = {
    ...initial,
    screen: ([
      "overview",
      "products",
      "review",
      "observability",
      "tasks",
      "settings",
    ].includes(screen ?? "")
      ? screen
      : "overview") as Screen,
    tab:
      screen === "observability"
        ? (legacy ? rawScreen : p.get("tab")) === "logs"
          ? "logs"
          : "updates"
        : undefined,
    mode: p.get("mode") === "all" ? "all" : "stores",
    search: p.get("search") ?? "",
    page:
      Number.isSafeInteger(Number(p.get("page"))) && Number(p.get("page")) > 0
        ? Number(p.get("page"))
        : 1,
  };
  for (const k of [
    "retailer",
    "brand_id",
    "source_id",
    "source_name",
    "run_id",
    "level",
    "correlation_id",
    "name_quality",
    "availability",
    "match_filter",
    "status",
    "kind",
  ] as const) {
    const v = p.get(k);
    if (v) Object.assign(next, { [k]: v });
  }
  // Only accept typed choices from a shareable URL.
  if (!["named", "invalid", "all"].includes(next.name_quality ?? ""))
    next.name_quality = initial.name_quality;
  if (
    !["available", "unavailable", "unknown", "all"].includes(
      next.availability ?? "",
    )
  )
    next.availability = initial.availability;
  if (
    next.match_filter &&
    !["all", "matched", "unmatched"].includes(next.match_filter)
  )
    next.match_filter = undefined;
  if (next.brand_id && !/^[0-9a-f-]{36}$/i.test(next.brand_id))
    next.brand_id = undefined;
  if (next.source_id && !/^[0-9a-f-]{36}$/i.test(next.source_id))
    next.source_id = undefined;
  if (next.run_id && !/^[0-9a-f-]{36}$/i.test(next.run_id))
    next.run_id = undefined;
  if (next.kind && !["discover", "catalog", "match"].includes(next.kind))
    next.kind = undefined;
  if (next.level && !["debug", "info", "warn", "error"].includes(next.level))
    next.level = undefined;
  if (
    next.status &&
    ![
      "pending",
      "queued",
      "running",
      "success",
      "failed",
      "quarantined",
      "superseded",
    ].includes(next.status)
  )
    next.status = undefined;
  return next;
}
