-- Additive metadata only. No catalog scan, model request or matching run.
ALTER TABLE store_products ADD COLUMN manual_facts jsonb NOT NULL DEFAULT '{}';
CREATE TABLE product_detail_edits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_product_id uuid NOT NULL REFERENCES store_products(id),
 group_id uuid NOT NULL REFERENCES products(id),
 actor text NOT NULL,
 action text NOT NULL CHECK(action IN ('update','reset')),
 changes jsonb NOT NULL,
 previous_overrides jsonb NOT NULL,
 overrides jsonb NOT NULL,
 note text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_detail_edits_product ON product_detail_edits(store_product_id,created_at DESC,id);
