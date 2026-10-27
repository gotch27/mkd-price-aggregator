-- Shared health across separately deployed web and worker hosts.
CREATE TABLE worker_heartbeats (key text PRIMARY KEY,seen_at timestamptz NOT NULL);
CREATE INDEX task_items_product ON task_items(task_id,store_product_id);
