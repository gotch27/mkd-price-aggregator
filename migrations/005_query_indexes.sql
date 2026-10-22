CREATE INDEX offers_listing ON offers(listing_id);
CREATE INDEX listings_name ON listings(name,id);
CREATE INDEX listings_gtin ON listings(gtin) WHERE gtin IS NOT NULL;
CREATE INDEX runs_source_latest ON runs(source_id,kind,created_at DESC);
CREATE INDEX logs_run ON logs(run_id,created_at DESC);
CREATE INDEX logs_retailer ON logs(retailer,created_at DESC);
CREATE INDEX decisions_created ON match_decisions(created_at DESC);
CREATE INDEX ai_usage_period ON ai_usage(created_at);
