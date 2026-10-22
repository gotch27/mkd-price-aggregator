import { pool } from "@/nextsignal/services/database";
import { retryRun } from "@/nextsignal/services/operations";
try {
  const result = await pool.query(
    `SELECT r.id FROM runs r WHERE r.status='failed' AND NOT EXISTS(SELECT 1 FROM runs newer WHERE newer.kind=r.kind AND newer.source_id IS NOT DISTINCT FROM r.source_id AND newer.retailer IS NOT DISTINCT FROM r.retailer AND newer.created_at>r.created_at)`,
  );
  const retried = [];
  for (const row of result.rows) {
    const run = await retryRun(row.id);
    retried.push({
      id: run.id,
      retailer: run.retailer,
      source_id: run.source_id,
    });
  }
  console.table(retried);
} finally {
  await pool.end();
}
