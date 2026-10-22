-- Derived browser data can be rebuilt without modifying source records.
DROP MATERIALIZED VIEW catalog_browser;
-- Browsing works on unique retailer articles rather than millions of branch copies.
-- Raw listings and scope-specific offers remain authoritative and are never removed.
CREATE MATERIALIZED VIEW catalog_browser AS
SELECT l.retailer, l.identity_hash, l.external_key,
       min(l.id::text)::uuid AS listing_id,
       min(l.name) AS name, min(l.normalized_name) AS normalized_name,
       min(l.category) AS category,
       min(l.normalized_name) ~ '[a-z]' AS usable_name,
       min(o.price) AS price, max(o.price) AS highest_price,
       count(*)::integer AS offer_count,
       count(DISTINCT o.source_id)::integer AS catalog_count,
       min(s.name) AS first_catalog,
       CASE WHEN bool_and(s.scope='branch') THEN 'branch' ELSE 'retailer' END AS scope,
       max(o.retrieved_at) AS retrieved_at
FROM listings l
JOIN offers o ON o.listing_id=l.id
JOIN sources s ON s.id=o.source_id AND s.active
GROUP BY l.retailer,l.identity_hash,l.external_key;
CREATE UNIQUE INDEX catalog_browser_identity ON catalog_browser(retailer,identity_hash,external_key);
CREATE INDEX catalog_browser_name ON catalog_browser(name,listing_id);
CREATE INDEX catalog_browser_retailer_name ON catalog_browser(retailer,name,listing_id);
CREATE INDEX catalog_browser_search ON catalog_browser USING gin(normalized_name gin_trgm_ops);
CREATE UNIQUE INDEX catalog_browser_listing ON catalog_browser(listing_id);
ANALYZE catalog_browser;
