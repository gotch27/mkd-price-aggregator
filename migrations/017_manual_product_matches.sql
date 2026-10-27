-- Append-only human decisions. Latest decision for a pair wins, while all
-- earlier decisions and memberships remain available for audit and undo.
CREATE TABLE manual_product_links (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 a_id uuid NOT NULL REFERENCES store_products(id),
 b_id uuid NOT NULL REFERENCES store_products(id),
 action text NOT NULL CHECK(action IN ('same','different')),
 actor text NOT NULL, note text NOT NULL,
 decision_id uuid NOT NULL REFERENCES store_match_decisions(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(a_id < b_id)
);
CREATE INDEX manual_product_links_pair ON manual_product_links(a_id,b_id,id DESC);
