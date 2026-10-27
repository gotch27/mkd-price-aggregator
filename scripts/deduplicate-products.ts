import { pool } from "@/nextsignal/services/database";
import {
  deduplicateProductBatch,
  refreshDuplicatePricesBatch,
} from "@/nextsignal/services/source-product-deduplication";
import { logEvent } from "@/nextsignal/adapters/log-context";
const args = process.argv.slice(2);
const get = (flag: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const phase = get("--phase"),
  size = Number(get("--batch-size")),
  maximum = Number(get("--maximum"));
if (
  !["products", "prices"].includes(phase ?? "") ||
  !Number.isInteger(size) ||
  size < 1 ||
  size > 1000 ||
  !Number.isInteger(maximum) ||
  maximum < 1
)
  throw new Error(
    "Specify --phase products|prices --batch-size 1..1000 --maximum N; dry run unless --apply is supplied",
  );
let cursor = get("--after") ?? null,
  examined = 0;
try {
  while (examined < maximum) {
    const options = {
      after: cursor,
      limit: Math.min(size, maximum - examined),
      apply: args.includes("--apply"),
    };
    const result =
      phase === "products"
        ? await deduplicateProductBatch(options)
        : await refreshDuplicatePricesBatch(options);
    console.info(JSON.stringify({ phase, ...result }));
    examined += "examined" in result ? result.examined : result.catalogs;
    cursor = result.cursor;
    if (result.completed) break;
  }
} catch (error) {
  await logEvent(
    "error",
    "catalog.duplicates.repair_failed",
    "Duplicate repair stopped; committed batches and original observations are preserved",
    { phase, cursor, examined },
    error,
  );
  throw error;
} finally {
  await pool.end();
}
