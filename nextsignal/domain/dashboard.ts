export const dashboardViews = [
  "summary",
  "sources",
  "products",
  "universal",
  "runs",
  "logs",
  "decisions",
] as const;
export type DashboardView = (typeof dashboardViews)[number];
export type TableView = Exclude<DashboardView, "summary">;
export type NameQuality = "named" | "invalid" | "all";
export type DashboardRow = Record<string, unknown>;
export type DashboardQuery = {
  view: DashboardView;
  search: string;
  page: number;
  size: number;
  retailer?: string;
  source_id?: string;
  run_id?: string;
  correlation_id?: string;
  level?: string;
  name_quality?: NameQuality;
  match_filter?: "all" | "matched" | "unmatched";
  status?: string;
  kind?: "discover" | "catalog" | "match";
};

export type ProductDetail = {
  product: DashboardRow;
  listings: DashboardRow[];
  offers: DashboardRow[];
  decisions: DashboardRow[];
};
export type DashboardPage = {
  view: TableView;
  rows: DashboardRow[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  refreshed_at: string | null;
  refresh_pending: boolean;
};
