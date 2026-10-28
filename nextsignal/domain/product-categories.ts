import type { ProductClassification } from "./dashboard";
export type CategoryEditInput = {
  id: string;
  member_id: string;
  snapshot: string;
  action: "set" | "accept_suggestion" | "reset";
  category: string | null;
  note: string;
};
export type CategorySaveResult = {
  changed: boolean;
  product_id: string;
  category: string | null;
  classification: ProductClassification;
};
export type CategoryEditView = {
  id: string;
  member_id: string;
  name: string;
  retailer: string;
  classification: ProductClassification;
  categories: { id: string; label: string }[];
  history: {
    id: string;
    actor: string;
    source: "human" | "agent" | "llm";
    action: string;
    before_category: string | null;
    after_category: string | null;
    note: string;
    created_at: string;
  }[];
  history_total: number;
  note_max_length: number;
  timezone: string;
};
