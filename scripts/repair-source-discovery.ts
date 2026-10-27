import { logEvent } from "@/nextsignal/adapters/log-context";
import { pool } from "@/nextsignal/services/database";
import {
  assertSourceDiscoveryRepairSafe,
  fetchSourceDiscoveryRepairPages,
  repairSourceDiscovery,
} from "@/nextsignal/services/source-discovery-repair";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply"))
  throw new Error(
    "Use no flags for a dry run; add --apply after reviewing it and safely stopping imports",
  );
const apply = args.includes("--apply");
try {
  if (apply) await assertSourceDiscoveryRepairSafe();
  const pages = await fetchSourceDiscoveryRepairPages();
  const result = await repairSourceDiscovery({
    pages,
    apply,
    actor: "maintenance:source-discovery",
  });
  console.info(JSON.stringify(result));
} catch (error) {
  if (apply)
    await logEvent(
      "error",
      "catalog.discovery_repair.failed",
      "Catalog discovery correction stopped; no partial metadata repair was committed",
      {},
      error,
    );
  throw error;
} finally {
  await pool.end();
}
