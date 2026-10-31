-- Existing sessions already selected from both untouched and skipped products.
-- Record that policy without changing their membership or saved decisions.
ALTER TABLE agent_category_sessions ADD COLUMN include_previously_skipped boolean;
UPDATE agent_category_sessions SET include_previously_skipped=true;
ALTER TABLE agent_category_sessions ALTER COLUMN include_previously_skipped SET NOT NULL;

-- Read previous skips directly from their durable records, including those made
-- before this change. No backfill of products or new review session is needed.
CREATE INDEX agent_category_items_skipped_product
 ON agent_category_items(store_product_id,(review_item#>>'{classification,classification_id}'))
 WHERE state='skipped';
