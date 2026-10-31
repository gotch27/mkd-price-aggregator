import type { Facts } from "./matching";
export const matchingOutcomes = [
  "connected",
  "already_connected",
  "needs_info",
  "ambiguous_store",
  "different",
  "no_candidates",
  "deferred",
  "stale",
  "skipped",
  "waiting",
] as const;
export type MatchingCandidateResult = {
  id: string;
  name: string;
  retailer: string;
  outcome: string;
  reason: string;
  probability: number | null;
  confidence: number | null;
  method: "code" | "decision";
  facts: Facts;
  source_facts: Facts;
  retrieval: string[];
};
export type MatchingResult = {
  kind: "match";
  name: string;
  retailer: string;
  product_id: string;
  member_id: string;
  outcome: (typeof matchingOutcomes)[number];
  reason: string;
  stores: string[];
  candidates: MatchingCandidateResult[];
};
export type MatchingResultsPage = {
  kind: "match";
  task: {
    id: string;
    state: string;
    reason: string;
    stores: string[];
    processed: number;
    product_limit: number | null;
    spending_usd: string;
    requests: number;
    phase: string;
    counterparts_planned: number;
    counterparts_consumed: number;
  };
  summary: Record<string, number>;
  rows: (MatchingResult & { id: string; finished_at: string | null })[];
  page: number;
  size: number;
  total: number;
  total_pages: number;
};
