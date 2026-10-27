import { pool } from "@/nextsignal/services/database";
import { repairSourceAvailability } from "@/nextsignal/services/product-availability";
import { logEvent } from "@/nextsignal/adapters/log-context";
const args = process.argv.slice(2);
if (
  args.some((a) => !["--apply", "--all"].includes(a)) ||
  args.includes("--apply") !== args.includes("--all")
)
  throw new Error(
    "Use no flags to inspect; --apply --all indexes existing saved availability, without imports or AI.",
  );
try {
  const pending = (
    await pool.query(
      `SELECT retailer,count(*)::int catalogs FROM sources WHERE availability_indexed_at IS NULL GROUP BY retailer ORDER BY retailer`,
    )
  ).rows;
  if (!args.includes("--apply"))
    console.info(JSON.stringify({ pending, external_requests: 0 }));
  else {
    if (
      (
        await pool.query(
          "SELECT 1 FROM task_executions WHERE state IN('queued','running') LIMIT 1",
        )
      ).rowCount
    )
      throw new Error(
        "Wait until active tasks finish or pause them before indexing saved availability.",
      );
    await logEvent(
      "info",
      "catalog.availability.repair_started",
      "Indexing saved product availability; no imports or AI calls",
      { pending },
    );
    let processed = 0;
    while (true) {
      const source = (
        await pool.query(
          "SELECT id FROM sources WHERE availability_indexed_at IS NULL ORDER BY retailer,id LIMIT 1",
        )
      ).rows[0];
      if (!source) break;
      const result = await repairSourceAvailability(source.id);
      if (!result)
        throw new Error(
          "Source is busy; saved checkpoints are retained. Run the repair again later.",
        );
      processed++;
      console.info(JSON.stringify({ processed, ...result }));
    }
    await logEvent(
      "info",
      "catalog.availability.repair_completed",
      "Saved product availability is ready; no imports or AI calls",
      { catalogs: processed },
    );
  }
} catch (error) {
  await logEvent(
    "error",
    "catalog.availability.repair_failed",
    "Availability indexing stopped; completed source checkpoints are kept",
    {},
    error,
  );
  throw error;
} finally {
  await pool.end();
}
