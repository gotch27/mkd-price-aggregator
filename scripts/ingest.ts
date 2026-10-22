import { app } from "@/nextsignal/app";
import { pool } from "@/nextsignal/services/database";
import { settings } from "@/nextsignal/config";
const args = process.argv.slice(2);
const retailer = args.find((a) => !a.startsWith("--")) ?? null;
if (!args.includes("--all") && !retailer)
  throw new Error("Choose --all or a retailer slug explicitly");
try {
  if (retailer && !settings.sources[retailer])
    throw new Error("Unknown retailer");
  const result = await app.dispatch("catalog.request", { retailer });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  console.info(JSON.stringify(result.data, null, 2));
} finally {
  await pool.end();
}
