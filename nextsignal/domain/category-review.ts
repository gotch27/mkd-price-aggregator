import type { ProductClassification } from "./dashboard";
import type { ProductAvailability } from "./availability";

export type CategoryReviewStatus =
  "needs_review" | "assigned" | "reviewed" | "agent" | "llm" | "all";
export type CategoryReviewQuery = {
  status: CategoryReviewStatus;
  retailer?: string;
  search: string;
  availability: "available" | "all";
  page: number;
  size: number;
};
export type CategoryReviewItem = {
  id: string;
  product_id: string;
  retailer: string;
  name: string;
  description: string | null;
  source_category: string | null;
  availability: ProductAvailability;
  facts: Record<string, string>;
  classification: ProductClassification;
};
export type CategoryReviewPage = {
  rows: CategoryReviewItem[];
  counts: {
    total: number;
    needs_review: number;
    assigned: number;
    reviewed: number;
    agent: number;
    llm: number;
  };
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
};
