import { useEffect, useState } from "react";
import type { DashboardPage } from "@/nextsignal/domain/dashboard";
import type { Row } from "@/app/_components/dashboard/types";

export function useTaskCatalogs(
  retailer: string,
  pageSize: number,
  onUnauthorized: () => void,
) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({
    retailer: "",
    rows: [] as Row[],
    loading: false,
    error: "",
  });
  useEffect(() => {
    if (!retailer) return;
    const controller = new AbortController();
    setState({ retailer, rows: [], loading: true, error: "" });
    async function load() {
      try {
        const rows: Row[] = [];
        let pages = 1;
        for (let page = 1; page <= pages; page++) {
          const query = new URLSearchParams({
            view: "sources",
            retailer,
            search: "",
            page: String(page),
            size: String(pageSize),
          });
          const response = await fetch(`/api/operations?${query}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (response.status === 401) {
            onUnauthorized();
            return;
          }
          const result: {
            ok: boolean;
            data?: DashboardPage;
            errors?: { message: string }[];
          } = await response.json();
          if (!response.ok || !result.ok)
            throw new Error(
              result.errors?.[0]?.message ?? "Unable to load catalogs",
            );
          const data = result.data;
          if (
            data?.view !== "sources" ||
            !Array.isArray(data.rows) ||
            !Number.isSafeInteger(data.total_pages) ||
            data.total_pages < 0
          )
            throw new Error("Unexpected catalog response");
          if (page === 1) pages = data.total_pages;
          rows.push(...data.rows);
        }
        if (!controller.signal.aborted)
          setState({ retailer, rows, loading: false, error: "" });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            retailer,
            rows: [],
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "Unable to load catalogs",
          });
      }
    }
    void load();
    return () => controller.abort();
  }, [retailer, pageSize, onUnauthorized, revision]);
  return {
    rows: state.retailer === retailer && retailer ? state.rows : [],
    loading: !!retailer && (state.retailer !== retailer || state.loading),
    error: state.retailer === retailer ? state.error : "",
    refresh: () => setRevision((value) => value + 1),
  };
}
