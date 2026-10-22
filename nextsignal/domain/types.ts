export type Retailer =
  | "kam"
  | "ramstore"
  | "stokomak"
  | "spar"
  | "zito"
  | "vero"
  | "zur"
  | "dim"
  | "reptil";
export type Source = {
  id: string;
  retailer: Retailer;
  external_id: string;
  name: string;
  url: string;
  scope: "branch" | "retailer";
  meta: Record<string, unknown>;
};
export type DiscoveredSource = Omit<Source, "id">;
export type Attributes = {
  brand: string | null;
  variant: string | null;
  quantity: string | null;
  unit: "g" | "ml" | "piece" | null;
  pack: number | null;
  form: string | null;
  gtin: string | null;
  ambiguous: boolean;
};
export type CatalogRow = {
  key: string;
  name: string;
  description: string | null;
  category: string | null;
  gtin: string | null;
  price: string | null;
  regular_price: string | null;
  promo_price: string | null;
  unit_price: string | null;
  available: boolean | null;
  promotion: string | null;
  source_updated_at: string | null;
  raw: Record<string, unknown>;
};
export type CatalogPage = {
  rows: CatalogRow[];
  next: string | null;
  total: number | null;
  artifact: string | null;
};
export type Run = {
  id: string;
  kind: "discover" | "catalog" | "match";
  retailer: Retailer | null;
  source_id: string | null;
  parent_id: string | null;
  status: string;
  checkpoint: Record<string, unknown>;
  created_at: Date;
  attempts: number;
};
export class SourceError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}
export class CatalogRestartRequired extends SourceError {
  constructor(message: string) {
    super(message, false);
    this.name = "CatalogRestartRequired";
  }
}
