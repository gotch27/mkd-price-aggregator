-- Derived dashboard data only. A null value distinguishes an older snapshot
-- from a real zero-product store until the worker refreshes the counts.
ALTER TABLE dashboard_product_snapshot ADD COLUMN retailer_counts jsonb;
INSERT INTO dashboard_refresh_events(transaction_id) VALUES(txid_current()) ON CONFLICT DO NOTHING;
