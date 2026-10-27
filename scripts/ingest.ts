import { randomUUID } from "node:crypto";
import { createTask } from "@/nextsignal/services/tasks";
import { readSettings } from "@/nextsignal/services/task-settings";
import type { TaskCommand } from "@/nextsignal/domain/task-settings";
import { pool } from "@/nextsignal/services/database";
import { settings } from "@/nextsignal/config";
const args = process.argv.slice(2);
const retailer = args.find((a) => !a.startsWith("--")) ?? null;
if (!args.includes("--all") && !retailer)
  throw new Error("Choose --all or a retailer slug explicitly");
try {
  if (retailer && !settings.sources[retailer])
    throw new Error("Unknown retailer");
  const saved = await readSettings();
  const task = await createTask(
    {
      revision: saved.revision,
      kind: "import",
      retailers: (retailer
        ? [retailer]
        : Object.keys(settings.sources).filter(
            (r) => settings.sources[r].enabled,
          )) as TaskCommand["retailers"],
      source_id: null,
      product_limit: null,
      use_ai: false,
      categories: [],
      max_cost_usd: 0,
      recheck: false,
      idempotency_key: randomUUID(),
    },
    "cli",
  );
  console.info("Authorized import task:", task.id);
} finally {
  await pool.end();
}
