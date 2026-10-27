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
export type MatchingSummary = {
  automatic_enabled: boolean;
  gateway_enabled: boolean;
  ai_categories: string[];
  indexing: { completed: boolean } | null;
  counts: Record<string, number>;
  work_counts: Record<string, number>;
  campaigns: {
    id: string;
    kind: string;
    state: string;
    reason: string;
    spent_usd: string;
    budget_usd: number;
  }[];
  monthly_spent_usd: string;
  monthly_budget_usd: number;
};
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
  availability?: (typeof import("./availability").availabilityFilters)[number];
  status?: string;
  kind?: "discover" | "catalog" | "match";
};

export type ProductClassification = {
  classification_id: string | null;
  options: { category: string; label: string; probability: number | null }[];
  state:
    | "assigned"
    | "uncertain"
    | "outdated"
    | "not_categorized"
    | "manual"
    | "agent";
  category: string | null;
  suggested_category: string | null;
  probability: number | null;
  threshold: number | null;
  manual_category: string | null;
  source?: "human" | "agent" | "decision_model" | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  review_reason?: string | null;
  model_category: string | null;
  can_accept_suggestion: boolean;
  snapshot: string;
};
export type ProductDetail = {
  product: DashboardRow;
  listings: (DashboardRow & { classification?: ProductClassification })[];
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
