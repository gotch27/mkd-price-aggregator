import {
  LayoutDashboard,
  PackageSearch,
  RefreshCw,
  ScrollText,
  ListTodo,
} from "lucide-react";
export type {
  DashboardView,
  TableView,
  ProductDetail,
} from "@/nextsignal/domain/dashboard";
export type Row = Record<string, unknown>;
export type Summary = {
  retailers: Row[];
  counts: Record<string, number>;
  ai: Row[];
  ai_enabled: boolean;
  local_enabled: boolean;
  refreshed_at: string | null;
  refresh_pending: boolean;
};
export type DateFormatter = (value: unknown) => string;
export const views = {
  overview: {
    label: "Overview",
    icon: LayoutDashboard,
    description: "Your catalog database, at a glance.",
  },
  products: {
    label: "Products",
    icon: PackageSearch,
    description: "Explore store catalogs and the products that connect them.",
  },
  updates: {
    label: "Data updates",
    icon: RefreshCw,
    description:
      "Follow catalog imports and product matching, from start to finish.",
  },
  tasks: {
    label: "Tasks",
    icon: ListTodo,
    description: "Choose a task, set its scope, and review it before starting.",
  },
  logs: {
    label: "Logs",
    icon: ScrollText,
    description: "A searchable record of what’s happening behind the scenes.",
  },
} as const;
export type Screen = keyof typeof views;
export type TaskSettings = {
  stores: { slug: string; name: string; enabled: boolean }[];
  matchingEnabled: boolean;
  localEnabled: boolean;
  aiEnabled: boolean;
};
export type TaskRequest = {
  endpoint: "/api/ingestion" | "/api/matching" | "/api/retry";
  body: Record<string, string | null>;
  title: string;
  scope: string;
  effect: string;
  submitLabel: string;
  successMessage: string;
};
export const storeNames: Record<string, string> = {
  kam: "KAM",
  ramstore: "Ramstore",
  stokomak: "Stokomak",
  spar: "SPAR",
  zito: "Žito",
  vero: "Vero",
  zur: "Žur",
  dim: "Dim",
  reptil: "Reptil",
};
export const storeName = (slug: unknown) =>
  storeNames[String(slug)] ?? String(slug ?? "All stores");
export const text = (value: unknown, empty = "—") =>
  value === null || value === undefined || value === "" ? empty : String(value);
export const number = (value: unknown) =>
  Number(value ?? 0).toLocaleString("en-GB");
export function price(value: unknown) {
  return value === null || value === undefined
    ? "Unknown"
    : `${Number(value).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MKD`;
}
export function priceRange(row: Row) {
  return row.price === null || row.price === undefined
    ? "Unknown"
    : row.highest_price !== null &&
        row.highest_price !== undefined &&
        Number(row.price) !== Number(row.highest_price)
      ? `${price(row.price)} – ${price(row.highest_price)}`
      : price(row.price);
}
export const kindName = (kind: unknown) =>
  ({
    discover: "Find store catalogs",
    catalog: "Import catalog prices",
    match: "Find product matches",
  })[String(kind)] ?? text(kind);
export const label = (key: string) =>
  key.replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase());
