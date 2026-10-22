-- Same-retailer article copies can be found without scanning all branch rows.
CREATE INDEX listings_identity ON listings(retailer,identity_hash,external_key);
CREATE UNIQUE INDEX catalog_browser_listing ON catalog_browser(listing_id);
