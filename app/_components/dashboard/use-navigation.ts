import { useEffect, useRef, useState } from "react";
import type {
  DashboardQuery,
  NameQuality,
} from "@/nextsignal/domain/dashboard";
import type { Screen } from "./types";
import {
  initialNavigation,
  navigationKey,
  navigationUrl,
  readNavigation,
  type NavigationState,
  type ObservabilityTab,
} from "./navigation-state";
export type { NavigationState } from "./navigation-state";

export function useNavigation(
  initialNameQuality: NameQuality,
  initialAvailability: NonNullable<DashboardQuery["availability"]>,
) {
  const initial = initialNavigation(initialNameQuality, initialAvailability);
  const [state, setState] = useState<NavigationState>(initial);
  const stateRef = useRef(state);
  stateRef.current = state;
  const saved = useRef(new Map<string, NavigationState>());
  const lastObservability = useRef<ObservabilityTab>("updates");
  function remember(next: NavigationState) {
    if (navigationKey(stateRef.current) !== navigationKey(next))
      saved.current.set(navigationKey(stateRef.current), stateRef.current);
    if (next.screen === "observability")
      lastObservability.current = next.tab ?? "updates";
    stateRef.current = next;
    setState(next);
  }
  useEffect(() => {
    function read() {
      const p = new URLSearchParams(window.location.search);
      const next = readNavigation(
        p,
        initialNavigation(initialNameQuality, initialAvailability),
      );
      if (p.get("screen") === "updates" || p.get("screen") === "logs") {
        p.set("screen", "observability");
        p.set("tab", next.tab!);
        window.history.replaceState(null, "", `?${p}`);
      }
      remember(next);
    }
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, [initialNameQuality, initialAvailability]);
  function go(patch: Partial<NavigationState>, replace = false) {
    const next = { ...stateRef.current, ...patch };
    if (next.screen !== "observability") next.tab = undefined;
    else next.tab = next.tab ?? "updates";
    const url = navigationUrl(next);
    // Tabs can report the same choice from both pointer and focus events.
    // Only meaningful navigation should add a browser-history entry.
    if (url === navigationUrl(stateRef.current)) return;
    remember(next);
    window.history[replace ? "replaceState" : "pushState"](null, "", url);
  }
  function navigate(screen: Screen, tab?: ObservabilityTab) {
    saved.current.set(navigationKey(stateRef.current), stateRef.current);
    const targetTab =
      screen === "observability"
        ? (tab ?? lastObservability.current)
        : undefined;
    const target = { ...initial, screen, tab: targetTab };
    go(saved.current.get(navigationKey(target)) ?? target);
  }
  return { state, go, navigate };
}
