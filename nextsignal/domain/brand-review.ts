export type BrandExample = {
  id: string;
  fingerprint: string;
  retailer: string;
  name: string;
  description: string | null;
  category: string | null;
  readable_name: string;
  quote: string;
  field: "name" | "description";
};
export type BrandReviewItem = {
  id: string;
  position: number;
  input_key: string;
  term: string;
  examples: BrandExample[];
  affected: number;
  state: "pending" | "saved" | "skipped" | "rejected";
  reason: string;
  brand_id: string | null;
  brand_name: string | null;
  undo_status: "restored" | "changed" | null;
};
export type BrandReviewStart = {
  request_id: string;
  limit: number;
  retailer?: string;
  search: string;
  reviewer: "human" | "agent";
  agent_name: string;
  agent_model: string;
  include_previously_skipped: boolean;
};
export type BrandReviewSession = {
  id: string;
  state: "active" | "completed" | "stopped";
  options: BrandReviewStart;
  total: number;
  processed: number;
  saved: number;
  skipped: number;
  rejected: number;
  can_undo: boolean;
  acknowledged_at: string | null;
  results: BrandReviewItem[];
};
export type BrandEvidence = {
  member_id: string;
  field: "name" | "description";
  quote: string;
};
export type BrandReviewDecision = {
  item_id: string;
  snapshot: string;
  action: "save" | "skip";
  brand_id: string | null;
  brand_revision: number | null;
  name: string | null;
  aliases: {
    name: string;
    retailer: string | null;
    evidence: BrandEvidence[];
  }[];
  reason: string;
};
export type BrandReviewSubmission = {
  id: string;
  request_id: string;
  reviewer: "human" | "agent";
  decisions: BrandReviewDecision[];
};
export type BrandReviewContext = {
  limits: {
    default_groups: number;
    default_include_previously_skipped: boolean;
    max_groups: number;
    batch_size: number;
    examples_per_group: number;
    scan_products: number;
    refresh_ms: number;
    results_page_size: number;
  };
  instructions: string;
  session: BrandReviewSession | null;
  refresh_pending: number;
};
export class BrandReviewConflict extends Error {}
