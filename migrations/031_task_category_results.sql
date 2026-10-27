ALTER TABLE task_items ADD COLUMN result jsonb;
ALTER TABLE task_items ADD COLUMN finished_at timestamptz;

-- Recover already-paid results using the exact provider generation owned by
-- their task. This does not classify anything or call a provider.
WITH recorded AS (
 SELECT DISTINCT ON (ti.id) ti.id,sp.name,sp.retailer,sp.category,sp.normalized_name,
   c.id AS classification_id,c.family,c.selected_family,c.probability,c.confidence,
   c.acceptance_threshold,c.model,c.prompt_key,c.created_at
 FROM task_items ti JOIN task_executions t ON t.id=ti.task_id AND t.kind='categorize'
 JOIN store_products sp ON sp.id=ti.store_product_id
 JOIN store_product_classifications c ON c.store_product_id=sp.id
 JOIN ai_usage u ON u.task_id=t.id AND u.generation_id=c.generation_id AND u.status='success'
 WHERE ti.state='completed' AND ti.result IS NULL
 ORDER BY ti.id,c.created_at DESC,c.id
)
UPDATE task_items ti SET finished_at=r.created_at,result=jsonb_build_object(
 'name',r.name,'retailer',r.retailer,'source_category',r.category,'search_name',r.normalized_name,
 'assigned_category',r.family,'suggested_category',r.selected_family,'probability',r.probability,
 'confidence',r.confidence,'threshold',r.acceptance_threshold,'classification_id',r.classification_id,
 'model',r.model,'prompt_key',r.prompt_key,
 'outcome',CASE WHEN r.family='unknown' THEN 'uncertain' ELSE 'assigned' END,
 'reason',CASE WHEN r.family='unknown' THEN 'Not enough certainty to assign a category' ELSE 'Category assigned' END
) FROM recorded r WHERE ti.id=r.id;
