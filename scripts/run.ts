import { app } from "@/nextsignal/app";
import { pool } from "@/nextsignal/services/database";
import { z } from "zod";
const runId = z.uuid().parse(process.argv[2]);
try {
  const result = await app.dispatch("catalog.execute", { run_id: runId });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const run = (
    await pool.query("SELECT status,error FROM runs WHERE id=$1", [runId])
  ).rows[0];
  if (run.status === "failed") throw new Error(run.error);
  console.info(result);
} finally {
  await pool.end();
}
