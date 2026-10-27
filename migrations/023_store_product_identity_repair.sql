-- Preserve mistaken ambiguity-only revisions and their history while routing
-- current branch observations to one descriptive store product.
CREATE TABLE store_product_redirects (
 from_id uuid PRIMARY KEY REFERENCES store_products(id),
 to_id uuid NOT NULL REFERENCES store_products(id),
 original_fingerprint text NOT NULL,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(from_id<>to_id)
);
CREATE INDEX store_product_redirects_target ON store_product_redirects(to_id);
