// Automatic work must not silently take over paused tasks or retry the same
// deferred product revision. Explicit recovery revisits its own selected items.
export function notHeldProductSql(kind: string, ownTask = "NULL::uuid") {
  return `NOT EXISTS(SELECT 1 FROM task_items held JOIN task_executions owner ON owner.id=held.task_id
    WHERE held.store_product_id=sp.id AND held.state IN ('pending','deferred') AND owner.kind=${kind} AND owner.id IS DISTINCT FROM ${ownTask}
    AND ((held.state='pending' AND owner.state IN ('queued','running','paused','cooldown'))
      OR (held.state='deferred' AND (held.input_version IS NULL OR held.input_version=sp.version))))`;
}
