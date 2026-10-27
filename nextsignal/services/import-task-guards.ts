import type { PoolClient } from "pg";
import { settings } from "@/nextsignal/config";
import {
  TaskConflict,
  type TaskCommand,
} from "@/nextsignal/domain/task-settings";
import { logEvent } from "@/nextsignal/adapters/log-context";

// Scope checks and task insertion/resumption share this short transaction lock.
// Checking queue capacity alone cannot prevent two reviewed full imports from
// serially downloading the same catalogs again.
export async function assertImportScopeAvailable(
  client: PoolClient,
  options: TaskCommand,
  ownTaskId: string | null = null,
) {
  if (options.kind !== "import") return;
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('import-task-scope',0))",
  );
  const conflict = (
    await client.query<{ id: string; stores: string[] }>(
      `SELECT t.id,ARRAY(SELECT s FROM jsonb_array_elements_text(t.options->'retailers') s
          WHERE s=ANY($1::text[])) AS stores
       FROM task_executions t WHERE t.kind='import' AND t.state IN ('queued','running')
         AND ($3::uuid IS NULL OR t.id<>$3) AND t.idempotency_key<>$4
         AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(t.options->'retailers') s WHERE s=ANY($1::text[]))
         AND ($2::uuid IS NULL OR t.options->>'source_id' IS NULL OR t.options->>'source_id'=$2::text)
       ORDER BY t.created_at,t.id LIMIT 1`,
      [
        options.retailers,
        options.source_id,
        ownTaskId,
        options.idempotency_key,
      ],
    )
  ).rows[0];
  if (!conflict) return;
  const stores = conflict.stores
    .map((store) => settings.sources[store].name)
    .join(", ");
  await logEvent(
    "info",
    "tasks.import.overlap.prevented",
    "Overlapping import prevented; the existing task keeps its progress",
    {
      existing_task_id: conflict.id,
      stores: conflict.stores,
      source_id: options.source_id,
    },
  );
  throw new TaskConflict(
    `An import is already queued or running for ${stores}. Follow that task or use its Retry failed button instead of starting another import.`,
  );
}
