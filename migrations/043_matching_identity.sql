-- Additive matching preparation/receipt state. No matching or categorization is queued.
CREATE TABLE matching_product_preparations (
 store_product_id uuid NOT NULL REFERENCES store_products(id), input_key text NOT NULL,
 profile text NOT NULL, facts jsonb NOT NULL, statuses jsonb NOT NULL,
 requested_fields jsonb NOT NULL, attempted boolean NOT NULL DEFAULT false,
 outcome text NOT NULL, reason text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(store_product_id,input_key)
);
CREATE TABLE matching_task_preparations (
 task_id uuid NOT NULL REFERENCES task_executions(id),store_product_id uuid NOT NULL REFERENCES store_products(id),
 position integer NOT NULL,consumed boolean NOT NULL DEFAULT false,fields_key text,
 PRIMARY KEY(task_id,store_product_id),UNIQUE(task_id,position)
);
CREATE TABLE matching_pair_answers (
 key text PRIMARY KEY,left_id uuid NOT NULL REFERENCES store_products(id),right_id uuid NOT NULL REFERENCES store_products(id),
 left_input text NOT NULL,right_input text NOT NULL,model text NOT NULL,prompt_key text NOT NULL,
 answer jsonb NOT NULL,receipt jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX matching_pair_answers_members ON matching_pair_answers(left_id,right_id);
CREATE INDEX store_match_decisions_campaign ON store_match_decisions(campaign_id,store_product_id,created_at);
-- New settings are explicit defaults; retain every previously saved choice.
WITH prior AS (
 SELECT * FROM operational_settings WHERE NOT(policy ? 'counterpart_limit') OR NOT(policy ? 'counterparts_per_product') FOR UPDATE
), changed AS (
 UPDATE operational_settings s SET policy=jsonb_build_object('counterpart_limit',50,'counterparts_per_product',5)||s.policy,
 revision=s.revision+1,updated_by='deployment:matching-identity-v1',updated_at=now()
 FROM prior p WHERE s.id=p.id RETURNING s.revision,s.policy,p.policy AS before_policy
)
INSERT INTO operational_settings_history(revision,actor,before_policy,after_policy,changes)
SELECT revision,'deployment:matching-identity-v1',before_policy,policy,
 '[{"field":"matching_preparation_limits","before":null,"after":{"counterpart_limit":50,"counterparts_per_product":5}}]'::jsonb FROM changed;

ALTER TABLE store_match_decisions ADD COLUMN task_id uuid REFERENCES task_executions(id);
CREATE INDEX store_match_decisions_task ON store_match_decisions(task_id,store_product_id,created_at);
