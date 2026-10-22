import { useEffect, useRef, useState } from "react";
import type {
  DashboardQuery,
  NameQuality,
} from "@/nextsignal/domain/dashboard";
import type { Screen } from "@/app/_components/dashboard/types";
export type NavigationState = Omit<DashboardQuery, "view" | "size"> & {
  screen: Screen;
  mode: "stores" | "all";
  source_name?: string;
};
export function useNavigation(initialNameQuality: NameQuality) {
  const initial: NavigationState = {
    screen: "overview",
    mode: "stores",
    search: "",
    page: 1,
    name_quality: initialNameQuality,
    retailer: undefined,
    source_id: undefined,
    source_name: undefined,
    run_id: undefined,
    level: undefined,
    match_filter: undefined,
    kind: undefined,
    status: undefined,
    correlation_id: undefined,
  };
  const [state, setState] = useState<NavigationState>(initial);
  const stateRef = useRef(state);
  stateRef.current = state;
  const saved = useRef<Partial<Record<Screen, NavigationState>>>({});
  useEffect(() => {
    function read() {
      const p = new URLSearchParams(window.location.search);
      const screen = p.get("screen"),
        mode = p.get("mode");
      const next: NavigationState = {
        ...initial,
        screen: (["overview", "products", "updates", "tasks", "logs"].includes(
          screen ?? "",
        )
          ? screen
          : "overview") as Screen,
        mode: mode === "all" ? "all" : "stores",
        search: p.get("search") ?? "",
        page: Math.max(1, Number(p.get("page")) || 1),
      };
      for (const k of [
        "retailer",
        "source_id",
        "source_name",
        "run_id",
        "level",
        "name_quality",
        "match_filter",
        "status",
        "kind",
      ] as const) {
        const v = p.get(k);
        if (v) Object.assign(next, { [k]: v });
      }
      // Only accept typed choices from a shareable URL.
      if (!["named", "invalid", "all"].includes(next.name_quality ?? ""))
        next.name_quality = initialNameQuality;
      if (
        next.match_filter &&
        !["all", "matched", "unmatched"].includes(next.match_filter)
      )
        next.match_filter = undefined;
      if (next.source_id && !/^[0-9a-f-]{36}$/i.test(next.source_id))
        next.source_id = undefined;
      if (next.run_id && !/^[0-9a-f-]{36}$/i.test(next.run_id))
        next.run_id = undefined;
      if (next.kind && !["discover", "catalog", "match"].includes(next.kind))
        next.kind = undefined;
      if (
        next.level &&
        !["debug", "info", "warn", "error"].includes(next.level)
      )
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
      setState(next);
    }
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
    // Initial values come from server configuration and remain fixed for this mount.
  }, [initialNameQuality]);
  function go(patch: Partial<NavigationState>, replace = false) {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    setState(next);
    const p = new URLSearchParams();
    for (const [key, value] of Object.entries(next))
      if (
        value !== undefined &&
        value !== "" &&
        !(key === "page" && value === 1)
      )
        p.set(key, String(value));
    window.history[replace ? "replaceState" : "pushState"](null, "", `?${p}`);
  }
  function navigate(screen: Screen) {
    saved.current[state.screen] = state;
    go(saved.current[screen] ?? { ...initial, screen });
  }
  return { state, go, navigate };
}
