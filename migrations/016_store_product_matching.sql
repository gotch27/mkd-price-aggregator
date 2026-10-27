-- Source observations stay intact. Matching works on durable, branch-deduplicated
-- store product revisions and records all changes to their shared-product groups.
ALTER TABLE products ADD COLUMN matching_version bigint NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN matching_conflict boolean NOT NULL DEFAULT false;
CREATE TABLE store_products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 retailer text NOT NULL REFERENCES retailers(slug), external_key text NOT NULL,
 fingerprint text NOT NULL, source_identity_hash text NOT NULL,
 name text NOT NULL, description text, category text, gtin text,
 normalized_name text NOT NULL, ambiguous boolean NOT NULL, branch_conflict boolean NOT NULL DEFAULT false,
 facts jsonb NOT NULL, family text NOT NULL, category_hints jsonb NOT NULL,
 local_key text, group_id uuid NOT NULL REFERENCES products(id),
 version bigint NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'pending'
 CHECK(state IN ('pending','matched','different','needs_info','no_candidates','deferred','legacy_conflict')),
 last_reason text NOT NULL DEFAULT 'New store product',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(retailer,external_key,fingerprint)
);
CREATE INDEX store_products_name ON store_products USING gin(normalized_name gin_trgm_ops);
CREATE INDEX store_products_group ON store_products(group_id,retailer);
CREATE INDEX store_products_barcode ON store_products(gtin) WHERE gtin IS NOT NULL;
CREATE INDEX store_products_local ON store_products(local_key) WHERE local_key IS NOT NULL;
CREATE INDEX store_products_family ON store_products(family,retailer);
CREATE INDEX store_products_brand ON store_products((facts->'brand'->>'value'));
CREATE INDEX store_products_amount ON store_products((facts->'unit'->>'value'),(facts->'quantity'->>'value'),family);
CREATE TABLE store_product_aliases (
 listing_id uuid PRIMARY KEY REFERENCES listings(id),
 store_product_id uuid NOT NULL REFERENCES store_products(id),
 source_id uuid NOT NULL REFERENCES sources(id)
);
CREATE INDEX store_product_aliases_product ON store_product_aliases(store_product_id,source_id);
CREATE INDEX store_product_aliases_source ON store_product_aliases(source_id);
CREATE TABLE store_product_observations (
 listing_id uuid NOT NULL REFERENCES listings(id),
 store_product_id uuid NOT NULL REFERENCES store_products(id),
 observed_at timestamptz NOT NULL DEFAULT now(),
 previous_group_id uuid NOT NULL REFERENCES products(id),
 PRIMARY KEY(listing_id,store_product_id)
);
CREATE TABLE store_product_sources (
 store_product_id uuid NOT NULL REFERENCES store_products(id),
 source_id uuid NOT NULL REFERENCES sources(id),
 price numeric(14,2), highest_price numeric(14,2), offer_count integer NOT NULL,
 retrieved_at timestamptz NOT NULL,
 PRIMARY KEY(store_product_id,source_id)
);
CREATE INDEX store_product_sources_source ON store_product_sources(source_id);
CREATE TABLE matching_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('initial','incremental','evaluation')),
 state text NOT NULL CHECK(state IN ('running','paused','completed')),
 reason text NOT NULL, source_id uuid REFERENCES sources(id),
 run_id uuid REFERENCES runs(id), created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz, paused_at timestamptz
);
CREATE UNIQUE INDEX matching_initial_once ON matching_campaigns(kind) WHERE kind='initial';
CREATE UNIQUE INDEX matching_active_scope ON matching_campaigns(coalesce(source_id,'00000000-0000-0000-0000-000000000000'::uuid)) WHERE state='running' AND kind='incremental';
CREATE TABLE matching_work (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_product_id uuid NOT NULL REFERENCES store_products(id),
 campaign_id uuid REFERENCES matching_campaigns(id),
 reason text NOT NULL, state text NOT NULL DEFAULT 'pending'
 CHECK(state IN ('pending','running','completed','deferred')),
 token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 input_key text, result_key text, error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(store_product_id)
);
CREATE INDEX matching_work_pending ON matching_work(state,created_at);
CREATE TABLE matching_neighbor_events (
 source_product_id uuid NOT NULL REFERENCES store_products(id),
 target_product_id uuid NOT NULL REFERENCES store_products(id),
 change_key text NOT NULL,
 PRIMARY KEY(source_product_id,target_product_id,change_key)
);
CREATE TABLE store_match_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_product_id uuid NOT NULL REFERENCES store_products(id),
 candidate_id uuid REFERENCES store_products(id), campaign_id uuid REFERENCES matching_campaigns(id),
 group_id uuid REFERENCES products(id), outcome text NOT NULL,
 reason text NOT NULL, input_key text NOT NULL, source_version bigint NOT NULL,
 evidence jsonb NOT NULL, model text, probability numeric, confidence numeric,
 prompt_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX store_match_decisions_product ON store_match_decisions(store_product_id,created_at DESC);
CREATE INDEX store_match_decisions_input ON store_match_decisions(input_key);
CREATE TABLE product_membership_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_product_id uuid NOT NULL REFERENCES store_products(id),
 from_group_id uuid REFERENCES products(id), to_group_id uuid NOT NULL REFERENCES products(id),
 decision_id uuid REFERENCES store_match_decisions(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE matching_state (
 key text PRIMARY KEY CHECK(key='store-products'),
 cursor uuid, completed boolean NOT NULL, rules_version text NOT NULL
);
INSERT INTO matching_state VALUES('store-products',NULL,false,'cross-store-v2');
ALTER TABLE ai_usage ADD COLUMN campaign_id uuid REFERENCES matching_campaigns(id);
ALTER TABLE ai_usage ADD COLUMN request_key text;
ALTER TABLE ai_usage ADD COLUMN generation_id text;
ALTER TABLE ai_usage ADD COLUMN reported_confidence jsonb;
ALTER TABLE ai_usage ALTER COLUMN cost_usd TYPE numeric(24,12);
CREATE UNIQUE INDEX ai_usage_inflight ON ai_usage(request_key) WHERE status IN ('reserved','uncertain');
CREATE INDEX ai_usage_campaign ON ai_usage(campaign_id);

-- This read view uses the compact store layer as it is backfilled. Unmapped
-- existing browser rows remain visible until their aliases have been migrated.
CREATE VIEW store_product_browser AS
SELECT sp.retailer,sp.fingerprint AS identity_hash,sp.external_key,
       representative.listing_id,sp.name,sp.normalized_name,sp.category,
       sp.normalized_name ~ '[a-z]' AS usable_name,
       prices.price,prices.highest_price,prices.offer_count,prices.catalog_count,
       prices.first_catalog,prices.scope,prices.retrieved_at,
       sp.id AS store_product_id,sp.group_id AS product_id,sp.state AS matching_state,
       sp.last_reason AS matching_reason
FROM store_products sp
JOIN LATERAL (SELECT min(listing_id::text)::uuid AS listing_id FROM store_product_aliases WHERE store_product_id=sp.id) representative ON representative.listing_id IS NOT NULL
JOIN LATERAL (
 SELECT min(ss.price) AS price,max(ss.highest_price) AS highest_price,
        sum(ss.offer_count)::integer AS offer_count,count(*)::integer AS catalog_count,
        min(s.name) AS first_catalog,
        CASE WHEN bool_and(s.scope='branch') THEN 'branch' ELSE 'retailer' END AS scope,
        max(ss.retrieved_at) AS retrieved_at
 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active
 WHERE ss.store_product_id=sp.id
) prices ON prices.catalog_count>0
UNION ALL
SELECT b.*,NULL::uuid,l.product_id,'pending'::text,'Waiting for store product indexing'::text
FROM catalog_browser b JOIN listings l ON l.id=b.listing_id
WHERE NOT EXISTS(SELECT 1 FROM store_product_aliases a WHERE a.listing_id=b.listing_id);

CREATE VIEW matching_decision_browser AS
SELECT d.id,d.listing_id,d.identity_hash,d.product_id,d.method,d.probability,d.evidence,d.model,d.prompt_version,d.created_at,d.retailer,d.listing_name,
       NULL::text AS reason,NULL::numeric AS confidence FROM match_decisions d
UNION ALL
SELECT d.id,a.listing_id,sp.fingerprint,d.group_id,d.outcome,d.probability,d.evidence,d.model,d.prompt_version,d.created_at,sp.retailer,sp.name,d.reason,d.confidence
FROM store_match_decisions d JOIN store_products sp ON sp.id=d.store_product_id
LEFT JOIN LATERAL(SELECT listing_id FROM store_product_aliases WHERE store_product_id=sp.id ORDER BY listing_id LIMIT 1) a ON true;
