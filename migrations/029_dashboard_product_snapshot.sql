CREATE TABLE dashboard_product_snapshot (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  counts jsonb NOT NULL,
  matching_counts jsonb NOT NULL DEFAULT '{}',
  work_counts jsonb NOT NULL DEFAULT '{}',
  rule_version text NOT NULL DEFAULT '',
  updated_at timestamptz
);
INSERT INTO dashboard_product_snapshot(id,counts) VALUES(true,
  '{"catalog_items":0,"unnamed":0,"universal_products":0,"cross_store_products":0,"matched":0,"local_indexed":0,"local_eligible":0}');
CREATE TABLE dashboard_refresh_events (
  id bigserial PRIMARY KEY, transaction_id bigint NOT NULL UNIQUE
);
INSERT INTO dashboard_refresh_events(transaction_id) VALUES(txid_current());

-- One event per committing transaction, without a shared singleton row lock.
-- Refresh removes only the event IDs it actually observed. A transaction that
-- commits later cannot lose its invalidation even if its sequence ID is older.
CREATE FUNCTION request_dashboard_product_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='sources' AND TG_OP='UPDATE' THEN
    IF NOT EXISTS(SELECT 1 FROM changed_rows n JOIN old_rows o USING(id) WHERE n.active IS DISTINCT FROM o.active) THEN RETURN NULL; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM changed_rows) THEN RETURN NULL;
  END IF;
  INSERT INTO dashboard_refresh_events(transaction_id) VALUES(txid_current()) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE FUNCTION request_dashboard_snapshot_after_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO dashboard_refresh_events(transaction_id) VALUES(txid_current()) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['store_products','matching_work','local_product_keys','sources','store_product_sources'] LOOP
    EXECUTE format('CREATE TRIGGER dashboard_stats_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION request_dashboard_product_snapshot()',table_name);
    EXECUTE format('CREATE TRIGGER dashboard_stats_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION request_dashboard_product_snapshot()',table_name);
    EXECUTE format('CREATE TRIGGER dashboard_stats_truncate AFTER TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION request_dashboard_snapshot_after_truncate()',table_name);
    IF table_name<>'store_product_sources' THEN
      EXECUTE format('CREATE TRIGGER dashboard_stats_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION request_dashboard_product_snapshot()',table_name);
    END IF;
  END LOOP;
END $$;
