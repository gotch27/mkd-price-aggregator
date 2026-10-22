-- Universal product browsing resolves identities for the compact browser index.
-- Cover the lookup so this read does not scan the wide, branch-level listings.
CREATE INDEX listings_browser_product ON listings(id) INCLUDE(product_id);
