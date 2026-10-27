-- Identity searches and counts must not calculate every branch price first.
-- Price aggregation remains in store_product_browser, used only after paging.
CREATE VIEW store_product_identity_browser AS
SELECT sp.retailer,sp.fingerprint AS identity_hash,sp.external_key,
       NULL::uuid AS listing_id,sp.name,sp.normalized_name,sp.category,
       sp.normalized_name ~ '[a-z]' AS usable_name,
       sp.id AS store_product_id,sp.group_id AS product_id,
       sp.state AS matching_state,sp.last_reason AS matching_reason,
       sp.id AS browser_id
FROM store_products sp
WHERE EXISTS (
  SELECT 1 FROM store_product_sources ss
  JOIN sources s ON s.id=ss.source_id AND s.active
  WHERE ss.store_product_id=sp.id
)
AND EXISTS (SELECT 1 FROM store_product_aliases a WHERE a.store_product_id=sp.id)
UNION ALL
SELECT b.retailer,b.identity_hash,b.external_key,b.listing_id,b.name,
       b.normalized_name,b.category,b.usable_name,NULL::uuid,l.product_id,
       'pending'::text,'Waiting for store product indexing'::text,b.listing_id
FROM catalog_browser b JOIN listings l ON l.id=b.listing_id
WHERE NOT EXISTS (SELECT 1 FROM store_product_aliases a WHERE a.listing_id=b.listing_id);

CREATE INDEX store_products_browser_name ON store_products(name,id);
CREATE INDEX store_products_browser_store_name ON store_products(retailer,name,id);
