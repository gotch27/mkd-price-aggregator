ALTER TABLE runs ADD COLUMN dispatch_phase text CHECK(dispatch_phase IN ('download','publish'));
ALTER TABLE runs ADD COLUMN downloaded_at timestamptz;
UPDATE runs SET downloaded_at=coalesce(last_progress_at,finished_at,started_at,created_at)
WHERE kind='catalog' AND checkpoint->>'done'='true';
ALTER TABLE store_product_aliases ADD COLUMN source_identity_hash text;

-- Preserve the previous one-download-per-store permission for existing settings
-- and task snapshots. New deployments use their explicit configured defaults.
WITH previous AS MATERIALIZED (
  SELECT * FROM operational_settings WHERE NOT policy ? 'per_store_downloads' FOR UPDATE
), changed AS (
  UPDATE operational_settings s SET policy=s.policy||'{"per_store_downloads":1}',
    revision=s.revision+1,updated_by='migration:catalog-pipeline',updated_at=now()
  FROM previous p WHERE s.id=p.id RETURNING s.*
)
INSERT INTO operational_settings_history(revision,actor,before_policy,after_policy,changes)
SELECT c.revision,c.updated_by,p.policy,c.policy,
  '[{"field":"per_store_downloads","before":null,"after":1}]'::jsonb
FROM changed c JOIN previous p USING(id);
UPDATE task_executions SET policy=policy||'{"per_store_downloads":1}'
WHERE NOT policy ? 'per_store_downloads';
CREATE TABLE task_import_limit_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES task_executions(id),
  actor text NOT NULL,settings_revision integer NOT NULL,
  before_limits jsonb NOT NULL,after_limits jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_ready_publication ON runs(created_at,id)
WHERE kind='catalog' AND status='pending' AND checkpoint->>'done'='true';
