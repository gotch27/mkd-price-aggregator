import type { CategoryReviewItem } from "./category-review";

export type AgentReviewStart = {
  request_id: string;
  limit: number;
  retailer?: string;
  search: string;
  agent_name: string;
  agent_model: string;
};
export type AgentReviewDecision = {
  member_id: string;
  snapshot: string;
  action: "set" | "skip";
  category: string | null;
  reason: string;
};
export type AgentReviewSubmission = {
  id: string;
  request_id: string;
  decisions: AgentReviewDecision[];
};
export type AgentReviewResult = {
  member_id: string;
  name: string;
  retailer: string;
  state: "pending" | "saved" | "skipped" | "rejected";
  category: string | null;
  reason: string;
  undo_status: "restored" | "changed" | null;
};
export type AgentReviewSession = {
  id: string;
  state: "active" | "completed" | "stopped";
  agent_name: string;
  agent_model: string;
  retailer: string | null;
  search: string;
  product_limit: number;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  total: number;
  processed: number;
  saved: number;
  skipped: number;
  rejected: number;
  can_undo: boolean;
  results: AgentReviewResult[];
};
export type AgentReviewContext = {
  limits: {
    default_products: number;
    max_products: number;
    batch_size: number;
    results_page_size: number;
    refresh_ms: number;
  };
  instructions: string;
  categories: { id: string; label: string; description: string }[];
  session: AgentReviewSession | null;
};
export type AgentReviewBatch = {
  session_id: string;
  state: AgentReviewSession["state"];
  store_guidance: Record<string, string>;
  products: (CategoryReviewItem & {
    readable_name: string;
    readable_description: string | null;
    readable_source_category: string | null;
    supported_facts: Record<string, unknown>;
  })[];
};

export type PreparedAgentReviewBatch = Pick<
  AgentReviewContext,
  "limits" | "instructions" | "categories"
> & {
  session: AgentReviewSession;
  batch: AgentReviewBatch;
};
