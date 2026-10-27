ALTER TABLE store_products
 ADD COLUMN category_review_source text CHECK(category_review_source IN ('human','agent')),
 ADD COLUMN category_review_actor text,
 ADD COLUMN category_reviewed_at timestamptz,
 ADD COLUMN category_review_reason text;
UPDATE store_products SET category_review_source='human' WHERE manual_family IS NOT NULL;
UPDATE store_products sp SET category_review_actor=e.actor,category_reviewed_at=e.created_at,category_review_reason=e.note
FROM (SELECT DISTINCT ON(store_product_id) store_product_id,actor,created_at,note FROM product_category_edits ORDER BY store_product_id,created_at DESC,id DESC) e
WHERE sp.id=e.store_product_id AND sp.manual_family IS NOT NULL;
ALTER TABLE product_category_edits ADD COLUMN source text NOT NULL DEFAULT 'human' CHECK(source IN ('human','agent'));

CREATE TABLE agent_category_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor text NOT NULL,request_id uuid NOT NULL,request_key text NOT NULL,
 agent_name text NOT NULL,agent_model text NOT NULL,
 retailer text,search text NOT NULL,product_limit integer NOT NULL CHECK(product_limit>0),
 state text NOT NULL CHECK(state IN ('active','completed','stopped')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor,request_id)
);
CREATE UNIQUE INDEX agent_category_one_active ON agent_category_sessions(actor) WHERE state='active';
CREATE TABLE agent_category_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id uuid NOT NULL REFERENCES agent_category_sessions(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,request_key text NOT NULL,result jsonb NOT NULL,
 undone_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(session_id,request_id)
);
CREATE TABLE agent_category_items (
 session_id uuid NOT NULL REFERENCES agent_category_sessions(id) ON DELETE CASCADE,
 store_product_id uuid NOT NULL REFERENCES store_products(id),
 position integer NOT NULL,review_item jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','saved','skipped','rejected')),
 category text,reason text NOT NULL,after_snapshot text,
 batch_id uuid REFERENCES agent_category_batches(id),undo_status text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(session_id,store_product_id),UNIQUE(session_id,position)
);
ALTER TABLE product_category_edits ADD COLUMN agent_session_id uuid REFERENCES agent_category_sessions(id);
CREATE INDEX agent_category_sessions_recent ON agent_category_sessions(actor,created_at DESC,id);
CREATE INDEX agent_category_items_batch ON agent_category_items(batch_id) WHERE batch_id IS NOT NULL;
