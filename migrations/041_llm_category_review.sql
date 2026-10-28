-- Preserve all decisions and edits; extend provenance for internal LLM tasks.
ALTER TABLE store_products DROP CONSTRAINT store_products_category_review_source_check;
ALTER TABLE store_products ADD CONSTRAINT store_products_category_review_source_check CHECK(category_review_source IN ('human','agent','llm'));
ALTER TABLE product_category_edits DROP CONSTRAINT product_category_edits_source_check;
ALTER TABLE product_category_edits ADD CONSTRAINT product_category_edits_source_check CHECK(source IN ('human','agent','llm'));
ALTER TABLE task_executions DROP CONSTRAINT task_executions_kind_check;
ALTER TABLE task_executions ADD CONSTRAINT task_executions_kind_check CHECK(kind IN ('discover','import','categorize','match','prepare','llm_review'));
ALTER TABLE product_category_edits ADD COLUMN review_model text, ADD COLUMN review_prompt_key text, ADD COLUMN review_generation_id text, ADD COLUMN review_task_id uuid REFERENCES task_executions(id);
