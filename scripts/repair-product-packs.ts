import { logEvent } from "@/nextsignal/adapters/log-context";
import { pool } from "@/nextsignal/services/database";
import { repairPackBatch } from "@/nextsignal/services/product-pack-repair";

const args = process.argv.slice(2);
const value = (flag: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const batchSize = Number(value("--batch-size"));
const maximum = Number(value("--max-products"));
const phase = value("--phase");
if (
  !Number.isInteger(batchSize) ||
  batchSize < 1 ||
  batchSize > 1000 ||
  !Number.isInteger(maximum) ||
  maximum < 1 ||
  (phase !== "store-products" && phase !== "listings")
)
  throw new Error(
    "Specify --phase store-products|listings --batch-size 1..1000 --max-products N; add --apply only after reviewing a dry run",
  );
let cursor = value("--after") ?? null;
let examined = 0;
try {
  do {
    const { changes: _changes, ...result } = await repairPackBatch({
      phase,
      after: cursor,
      limit: Math.min(batchSize, maximum - examined),
      apply: args.includes("--apply"),
    });
    console.info(JSON.stringify(result));
    examined += result.examined;
    cursor = result.cursor;
    if (result.completed) break;
  } while (examined < maximum);
} catch (error) {
  await logEvent(
    "error",
    "matching.pack_repair.failed",
    "Product pack repair stopped; committed batches and saved history are preserved",
    { cursor, examined, applied: args.includes("--apply") },
    error,
  );
  throw error;
} finally {
  await pool.end();
}
