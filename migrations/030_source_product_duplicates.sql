-- Source rows/offers remain unchanged. These summarize duplicate observations
-- without discarding conflicting prices or treating repeats as new products.
ALTER TABLE store_product_sources ADD COLUMN duplicate_count integer NOT NULL DEFAULT 0;
ALTER TABLE store_product_sources ADD COLUMN price_conflict boolean NOT NULL DEFAULT false;
ALTER TABLE store_products ADD COLUMN duplicate_conflict boolean NOT NULL DEFAULT false;
CREATE INDEX store_products_descriptive ON store_products(retailer,fingerprint);
CREATE TABLE store_product_deduplications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 canonical_id uuid NOT NULL REFERENCES store_products(id),
 retired_id uuid NOT NULL UNIQUE REFERENCES store_products(id),
 previous_record jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
