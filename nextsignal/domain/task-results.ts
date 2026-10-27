import type { ProductClassification } from "./dashboard";
export type CategoryResult = {
  source: "ai" | "manual" | "agent";
  name: string;
  retailer: string;
  source_category: string | null;
  search_name: string;
  assigned_category: string | null;
  suggested_category: string | null;
  probability: number | null;
  confidence: number | null;
  threshold: number | null;
  classification_id: string | null;
  model: string | null;
  prompt_key: string | null;
  outcome: "assigned" | "uncertain" | "no_category" | "skipped" | "deferred";
  reason: string;
};
export type TaskResultsQuery = {
  id: string;
  page: number;
  size: number;
  search: string;
  category: string;
  outcome: string;
};
export type TaskResultsPage = {
  task: {
    id: string;
    state: string;
    reason: string;
    retry_at: string | null;
    stores: string[];
    processed: number;
    product_limit: number | null;
    spending_usd: string;
    requests: number;
  };
  summary: {
    total: number;
    assigned: number;
    needs_review: number;
    reviewed: number;
    skipped: number;
    waiting: number;
    deferred: number;
  };
  categories: { id: string; count: number }[];
  rows: (Omit<CategoryResult, "outcome"> & {
    id: string;
    product_id: string;
    member_id: string | null;
    manual_category: string | null;
    finished_at: string | null;
    classification?: ProductClassification;
    outcome: CategoryResult["outcome"] | "waiting";
  })[];
  page: number;
  size: number;
  total: number;
  total_pages: number;
};
