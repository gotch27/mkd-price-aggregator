-- Additive only: no catalog scan, reclassification or matching is launched here.
CREATE TABLE matching_prompt_versions (
 key text PRIMARY KEY,
 files jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ai_usage ADD COLUMN operation text;
ALTER TABLE ai_usage ADD COLUMN prompt_key text REFERENCES matching_prompt_versions(key);
ALTER TABLE store_match_decisions ADD COLUMN prompt_key text REFERENCES matching_prompt_versions(key);
ALTER TABLE store_products ADD COLUMN classified_family text;
ALTER TABLE store_products ADD COLUMN classification_key text;
ALTER TABLE store_products ADD COLUMN classification_attempt_key text;
ALTER TABLE store_products ADD COLUMN classification_threshold numeric;
ALTER TABLE store_products DROP CONSTRAINT store_products_state_check;
ALTER TABLE store_products ADD CONSTRAINT store_products_state_check
 CHECK(state IN ('pending','matched','different','needs_info','no_candidates','deferred','legacy_conflict','category_excluded'));
CREATE INDEX store_products_ai_category ON store_products(classified_family,state,id);
CREATE INDEX store_products_uncategorized ON store_products(id) WHERE classification_key IS NULL AND classification_attempt_key IS NULL;
CREATE TABLE store_product_classifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_product_id uuid NOT NULL REFERENCES store_products(id),
 input_key text NOT NULL,
 family text NOT NULL,
 selected_family text NOT NULL,
 probability numeric NOT NULL,
 confidence numeric,
 probabilities jsonb NOT NULL,
 acceptance_threshold numeric NOT NULL,
 model text NOT NULL,
 prompt_key text NOT NULL REFERENCES matching_prompt_versions(key),
 generation_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(store_product_id,input_key,acceptance_threshold)
);
CREATE INDEX store_product_classifications_product ON store_product_classifications(store_product_id,created_at DESC);
