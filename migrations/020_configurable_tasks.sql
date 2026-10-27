-- No backfill, import, provider request or settings activation is performed.
CREATE TABLE operational_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 revision integer NOT NULL CHECK(revision>0), policy jsonb NOT NULL, epochs jsonb NOT NULL,
 updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 next_due timestamptz, initial_cutoff timestamptz
);
CREATE TABLE operational_settings_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision integer NOT NULL UNIQUE,
 actor text NOT NULL, before_policy jsonb, after_policy jsonb NOT NULL,
 changes jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE task_executions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('discover','import','categorize','match','prepare')),
 origin text NOT NULL CHECK(origin IN ('manual','scheduled','automatic')),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','paused','completed','failed')),
 manual_authorized boolean NOT NULL, settings_revision integer NOT NULL,
 policy jsonb NOT NULL, epochs jsonb NOT NULL, options jsonb NOT NULL,
 idempotency_key text NOT NULL UNIQUE, created_by text NOT NULL,
 checkpoint jsonb NOT NULL DEFAULT '{}', reason text NOT NULL,
 selected integer NOT NULL DEFAULT 0, processed integer NOT NULL DEFAULT 0,
 connected integer NOT NULL DEFAULT 0, unresolved integer NOT NULL DEFAULT 0,
 campaign_id uuid REFERENCES matching_campaigns(id),
 dispatch_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_executions_pending ON task_executions(state,created_at);
CREATE TABLE task_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES task_executions(id),
 input_id uuid NOT NULL, store_product_id uuid REFERENCES store_products(id), listing_id uuid REFERENCES listings(id),
 group_id uuid NOT NULL REFERENCES products(id), input_hash text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed','unresolved')),
 reason text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,input_id)
);
ALTER TABLE runs ADD COLUMN task_id uuid REFERENCES task_executions(id);
ALTER TABLE runs DROP CONSTRAINT runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK(status IN ('pending','queued','running','success','failed','quarantined','superseded','paused'));
CREATE INDEX runs_task ON runs(task_id,status);
ALTER TABLE ai_usage ADD COLUMN task_id uuid REFERENCES task_executions(id);
CREATE INDEX ai_usage_task ON ai_usage(task_id);
ALTER TABLE store_products ADD COLUMN category_pending boolean NOT NULL DEFAULT true;
ALTER TABLE store_products ADD COLUMN rules_pending boolean NOT NULL DEFAULT true;
ALTER TABLE store_products ADD COLUMN ai_pending boolean NOT NULL DEFAULT true;
ALTER TABLE matching_work ADD COLUMN auto_category_epoch integer;
ALTER TABLE matching_work ADD COLUMN auto_match_epoch integer;
ALTER TABLE matching_work ADD COLUMN auto_ai_epoch integer;
CREATE INDEX matching_work_auto_category ON matching_work(auto_category_epoch) WHERE auto_category_epoch IS NOT NULL;
CREATE INDEX matching_work_auto_match ON matching_work(auto_match_epoch) WHERE auto_match_epoch IS NOT NULL;

-- Scoped tasks have independent incremental campaigns, but share the ledger caps.
DROP INDEX matching_active_scope;
CREATE INDEX matching_campaign_scope ON matching_campaigns(source_id,state);
