import { useEffect, useMemo, useState } from "react";
import type {
  DashboardPage,
  DashboardQuery,
  DashboardView,
} from "@/nextsignal/domain/dashboard";
import type { Summary } from "@/app/_components/dashboard/types";
type RequestState = {
  key: string;
  resultScope: string;
  loading: boolean;
  error: string;
  summary: Summary | null;
  page: DashboardPage | null;
};
type Options = {
  signedIn: boolean;
  query: DashboardQuery;
  refreshMs: number;
  debounceMs: number;
  autoRefreshViews: DashboardView[];
  setSignedIn: (value: boolean) => void;
};
export function useDashboardData({
  signedIn,
  query,
  refreshMs,
  debounceMs,
  autoRefreshViews,
  setSignedIn,
}: Options) {
  const [search, setSearch] = useState(query.search);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<RequestState>({
    key: "",
    resultScope: "",
    loading: false,
    error: "",
    summary: null,
    page: null,
  });
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.search), debounceMs);
    return () => clearTimeout(timer);
  }, [query.search, debounceMs]);
  const key = useMemo(() => {
    const p = new URLSearchParams({
      view: query.view,
      search,
      page: String(query.page),
      size: String(query.size),
    });
    for (const field of [
      "retailer",
      "source_id",
      "level",
      "run_id",
      "correlation_id",
      "name_quality",
      "match_filter",
      "status",
      "kind",
    ] as const)
      if (query[field]) p.set(field, query[field]);
    return p.toString();
  }, [
    query.view,
    search,
    query.page,
    query.size,
    query.retailer,
    query.source_id,
    query.level,
    query.run_id,
    query.correlation_id,
    query.name_quality,
    query.match_filter,
    query.status,
    query.kind,
  ]);
  const scope = useMemo(() => {
    const p = new URLSearchParams(key);
    p.delete("page");
    return p.toString();
  }, [key]);
  useEffect(() => {
    if (!signedIn) return;
    let disposed = false,
      running = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recurring = autoRefreshViews.includes(query.view);
    function schedule() {
      if (recurring && !disposed)
        timer = setTimeout(() => void load(), refreshMs);
    }
    async function load() {
      if (running || disposed) return;
      clearTimeout(timer);
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      running = true;
      controller = new AbortController();
      setState((prev) => ({ ...prev, key, loading: true, error: "" }));
      try {
        const response = await fetch(`/api/operations?${key}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          setSignedIn(false);
          return;
        }
        const result = await response.json();
        if (!result.ok)
          throw new Error(result.errors?.[0]?.message ?? "Unable to load data");
        if (disposed) return;
        if (
          query.view !== "summary" &&
          (result.data.view !== query.view || !Array.isArray(result.data.rows))
        )
          throw new Error("Unexpected dashboard response");
        setState({
          key,
          resultScope: scope,
          loading: false,
          error: "",
          summary: query.view === "summary" ? result.data : null,
          page: query.view === "summary" ? null : result.data,
        });
      } catch (error) {
        if (!disposed && !controller.signal.aborted)
          setState((prev) => ({
            ...prev,
            key,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      } finally {
        running = false;
        if (!disposed) {
          setState((prev) => ({ ...prev, loading: false }));
          schedule();
        }
      }
    }
    const onVisible = () => {
      if (document.visibilityState === "visible" && recurring) void load();
    };
    void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [
    key,
    scope,
    signedIn,
    query.view,
    refreshMs,
    autoRefreshViews,
    setSignedIn,
    revision,
  ]);
  // Retain rows only during pagination within the same complete filter scope.
  // Different stores, catalogs, and views never display each other's results.
  return {
    summary: state.resultScope === scope ? state.summary : null,
    page: state.resultScope === scope ? state.page : null,
    loading:
      signedIn &&
      (state.key !== key || state.loading || search !== query.search),
    error: state.key === key ? state.error : "",
    refresh: () => setRevision((v) => v + 1),
  };
}
