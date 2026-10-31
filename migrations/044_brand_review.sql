-- No external work is authorized by this migration.
CREATE TABLE matching_primary_preparations (
 task_id uuid NOT NULL REFERENCES task_executions(id),primary_id uuid NOT NULL REFERENCES store_products(id),
 store_product_id uuid NOT NULL REFERENCES store_products(id),PRIMARY KEY(task_id,primary_id,store_product_id)
);
CREATE TABLE brand_review_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor text NOT NULL,request_id uuid NOT NULL,request_key text NOT NULL,
 agent_name text NOT NULL,agent_model text NOT NULL,state text NOT NULL,options jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),acknowledged_at timestamptz,
 UNIQUE(actor,request_id)
);
CREATE TABLE brand_review_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_id uuid NOT NULL REFERENCES brand_review_sessions(id),
 request_id uuid NOT NULL,request_key text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),undone_at timestamptz,
 UNIQUE(session_id,request_id)
);
CREATE TABLE brand_review_items (
 session_id uuid NOT NULL REFERENCES brand_review_sessions(id),id uuid NOT NULL DEFAULT gen_random_uuid(),position integer NOT NULL,
 input_key text NOT NULL,term text NOT NULL,examples jsonb NOT NULL,affected integer NOT NULL,
 state text NOT NULL DEFAULT 'pending',reason text NOT NULL DEFAULT '',brand_id uuid REFERENCES brands(id),
 before_record jsonb,after_record jsonb,batch_id uuid REFERENCES brand_review_batches(id),undo_status text,
 PRIMARY KEY(session_id,id)
);
CREATE INDEX brand_review_skip_memory ON brand_review_items(input_key) WHERE state='skipped';
CREATE TABLE brand_fact_refresh (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sequence bigserial UNIQUE,request_key text NOT NULL UNIQUE,aliases jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending',cursor uuid,updated_products integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE brand_edits ADD COLUMN source text NOT NULL DEFAULT 'human';
ALTER TABLE brand_edits ADD COLUMN reason text NOT NULL DEFAULT '';
ALTER TABLE brand_edits ADD COLUMN session_id uuid REFERENCES brand_review_sessions(id);
ALTER TABLE brands ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE brand_fact_refresh ADD COLUMN brand_id uuid REFERENCES brands(id) ON DELETE SET NULL;
ALTER TABLE brand_fact_refresh ADD COLUMN undo_requested boolean NOT NULL DEFAULT false;
ALTER TABLE brand_fact_refresh ADD COLUMN product_ids uuid[] NOT NULL DEFAULT '{}';
CREATE TABLE brand_fact_changes (
 job_id uuid NOT NULL REFERENCES brand_fact_refresh(id),store_product_id uuid NOT NULL REFERENCES store_products(id),
 fingerprint text NOT NULL,before_fact jsonb,after_fact jsonb,restored boolean NOT NULL DEFAULT false,
 PRIMARY KEY(job_id,store_product_id)
);
ALTER TABLE brand_review_items ADD COLUMN refresh_job_id uuid REFERENCES brand_fact_refresh(id);
CREATE TABLE brand_review_skips (
 store_product_id uuid NOT NULL REFERENCES store_products(id),fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(store_product_id,fingerprint)
);
CREATE OR REPLACE FUNCTION set_product_brand_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT id INTO NEW.brand_id FROM brands WHERE slug=NEW.facts->'brand'->>'value' AND active;
 RETURN NEW;
END $$;
CREATE TABLE classification_source_snapshots (
 store_product_id uuid NOT NULL REFERENCES store_products(id),input_key text NOT NULL,
 source jsonb NOT NULL,model text NOT NULL,prompt_key text NOT NULL,
 PRIMARY KEY(store_product_id,input_key)
);
-- Preserve current decisions while changing the dictionary independently.
INSERT INTO classification_source_snapshots(store_product_id,input_key,source,model,prompt_key)
 SELECT sp.id,sp.classification_key,jsonb_build_object('retailer',sp.retailer,'name',sp.name,'description',sp.description,'category',sp.category,'gtin',sp.gtin,'manual_facts',sp.manual_facts),c.model,c.prompt_key
 FROM store_products sp JOIN LATERAL (
 SELECT model,prompt_key FROM store_product_classifications WHERE store_product_id=sp.id AND input_key=sp.classification_key ORDER BY created_at DESC,id DESC LIMIT 1
 ) c ON true WHERE sp.classification_key IS NOT NULL;
