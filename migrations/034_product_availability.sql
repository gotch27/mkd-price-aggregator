-- Compact branch availability comes from offers, never from a product's price.
-- Existing rows stay unknown until the bounded source repair has read them.
ALTER TABLE store_product_sources ADD COLUMN available boolean;
ALTER TABLE sources ADD COLUMN availability_indexed_at timestamptz;
CREATE INDEX store_product_sources_available ON store_product_sources(store_product_id,source_id) WHERE available IS TRUE;
CREATE VIEW store_product_availability AS
SELECT sp.id AS store_product_id,CASE
 WHEN EXISTS(SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active
   WHERE ss.store_product_id=sp.id AND ss.available IS TRUE AND s.availability_indexed_at IS NOT NULL) THEN 'available'
 WHEN EXISTS(SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active
   WHERE ss.store_product_id=sp.id AND (ss.available IS NULL OR s.availability_indexed_at IS NULL)) THEN 'unknown'
 WHEN EXISTS(SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active
   WHERE ss.store_product_id=sp.id) THEN 'unavailable'
 ELSE 'not_listed' END AS availability FROM store_products sp;
-- Prefer prices from branches that report availability; retain published prices
-- for explicitly browsing unavailable products.
CREATE OR REPLACE VIEW store_product_browser AS
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
 SELECT coalesce(min(ss.price) FILTER(WHERE ss.available IS TRUE AND s.availability_indexed_at IS NOT NULL),min(ss.price)) AS price,coalesce(max(ss.highest_price) FILTER(WHERE ss.available IS TRUE AND s.availability_indexed_at IS NOT NULL),max(ss.highest_price)) AS highest_price,
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

ALTER TABLE dashboard_product_snapshot ADD COLUMN availability_counts jsonb;
CREATE FUNCTION request_dashboard_availability_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM changed_rows n JOIN old_rows o USING(store_product_id,source_id) WHERE n.available IS DISTINCT FROM o.available) THEN
  INSERT INTO dashboard_refresh_events(transaction_id) VALUES(txid_current()) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER dashboard_availability_update AFTER UPDATE ON store_product_sources REFERENCING OLD TABLE AS old_rows NEW TABLE AS changed_rows
 FOR EACH STATEMENT EXECUTE FUNCTION request_dashboard_availability_snapshot();
INSERT INTO dashboard_refresh_events(transaction_id) VALUES(txid_current()) ON CONFLICT DO NOTHING;
