-- Unknown availability is sparse once saved catalogs have been indexed.
-- Separate it from unindexed catalogs so normal browsing does not scan every
-- branch row to prove that a product has no unknown observations.
CREATE INDEX store_product_sources_unknown_availability ON store_product_sources(store_product_id,source_id) WHERE available IS NULL;
CREATE OR REPLACE VIEW store_product_availability AS
SELECT sp.id AS store_product_id,CASE
 WHEN EXISTS(SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active
   WHERE ss.store_product_id=sp.id AND ss.available IS TRUE AND s.availability_indexed_at IS NOT NULL) THEN 'available'
 WHEN EXISTS(SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active
   WHERE ss.store_product_id=sp.id AND ss.available IS NULL) THEN 'unknown'
 WHEN (SELECT EXISTS(SELECT 1 FROM sources WHERE active AND availability_indexed_at IS NULL))
   AND EXISTS(SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active
     WHERE ss.store_product_id=sp.id AND s.availability_indexed_at IS NULL) THEN 'unknown'
 WHEN EXISTS(SELECT 1 FROM store_product_sources ss JOIN sources s ON s.id=ss.source_id AND s.active
   WHERE ss.store_product_id=sp.id) THEN 'unavailable'
 ELSE 'not_listed' END AS availability FROM store_products sp;
