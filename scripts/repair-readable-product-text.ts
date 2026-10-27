import { refreshProductTextIndex } from "@/nextsignal/services/product-text-index";
import { pool } from "@/nextsignal/services/database";
import { withLogContext } from "@/nextsignal/adapters/log-context";
try {
  if (!process.argv.includes("--apply"))
    throw new Error(
      "Pass --apply to rebuild only derived readable search text and supported rule facts. No imports or AI calls are made.",
    );
  const result = await withLogContext(
    { process: "products.text_index" },
    refreshProductTextIndex,
  );
  if (result === null)
    throw new Error("A readable product update is already running.");
  console.info(result);
} finally {
  await pool.end();
}
