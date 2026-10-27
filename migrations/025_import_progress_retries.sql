-- Execution turns and failed requests are different counters. A saved page
-- starts a new bounded retry allowance; yielding never spends that allowance.
ALTER TABLE runs ADD COLUMN retry_failures integer NOT NULL DEFAULT 0 CHECK(retry_failures>=0);
ALTER TABLE runs ADD COLUMN last_progress_at timestamptz;
UPDATE runs SET checkpoint=jsonb_set(checkpoint,'{pages_saved}',to_jsonb(greatest(0,(checkpoint->>'cursor')::integer-1)))
 WHERE kind='catalog' AND checkpoint->>'cursor' ~ '^[0-9]+$' AND NOT checkpoint ? 'pages_saved';
CREATE INDEX runs_unstarted_catalogs ON runs(task_id,retailer,created_at) WHERE kind='catalog' AND attempts=0;
