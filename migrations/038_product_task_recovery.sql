-- Preserve all accepted categories, task checkpoints and billing reservations.
ALTER TABLE task_items DROP CONSTRAINT task_items_state_check;
ALTER TABLE task_items ADD CONSTRAINT task_items_state_check
 CHECK(state IN ('pending','completed','unresolved','deferred'));
ALTER TABLE task_items ADD COLUMN deferred_usage_id uuid REFERENCES ai_usage(id);
CREATE INDEX task_items_deferred ON task_items(task_id) WHERE state='deferred';
ALTER TABLE ai_usage ADD COLUMN http_status integer;
ALTER TABLE ai_usage ADD COLUMN failure_phase text;
