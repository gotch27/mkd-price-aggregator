import type { Facts } from "@/nextsignal/domain/matching";

export type ManualMember = {
  id: string; // Durable product ID, or original listing ID before indexing.
  indexed: boolean;
  retailer: string;
  name: string;
  description: string | null;
  category: string | null;
  facts: Facts;
  active: boolean;
};
export type ManualGroup = {
  id: string;
  snapshot: string;
  members: ManualMember[];
  conflict: boolean;
  limited: boolean;
};
export type ManualSearch = {
  group: ManualGroup | null;
  candidates: ManualGroup[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  limits: { search_min_length: number; max_note_length: number };
};
export type ManualCommand = {
  id: string;
  action: "connect" | "separate";
  snapshot: string;
  candidate_id?: string;
  candidate_snapshot?: string;
  member_id?: string;
  note: string;
};
export type ManualResult =
  { ok: true; product_id: string } | { ok: false; reason: string };
