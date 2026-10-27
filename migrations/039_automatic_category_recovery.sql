-- Existing Automatic choices and paused tasks are preserved. Backlog activation
-- requires an explicit settings save in the new interface; no work is enqueued.
ALTER TABLE operational_settings ADD COLUMN category_backlog_epoch integer;
ALTER TABLE task_executions DROP CONSTRAINT task_executions_state_check;
ALTER TABLE task_executions ADD CONSTRAINT task_executions_state_check
 CHECK(state IN ('queued','running','paused','completed','failed','cooldown'));
ALTER TABLE task_executions ADD COLUMN retry_at timestamptz;
ALTER TABLE task_items ADD COLUMN input_version integer;
CREATE INDEX task_items_product_hold ON task_items(store_product_id,task_id) WHERE state IN ('pending','deferred');
CREATE INDEX store_products_category_backlog ON store_products(id) WHERE category_pending AND manual_family IS NULL;
CREATE INDEX task_cooldown_due ON task_executions(retry_at) WHERE state='cooldown';
CREATE TABLE gateway_cooldown (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 failures integer NOT NULL DEFAULT 0 CHECK(failures>=0),
 cycles integer NOT NULL DEFAULT 0 CHECK(cycles>=0),
 retry_at timestamptz,
 probe_token uuid, probe_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
