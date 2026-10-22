import { reindexProductNames } from "@/nextsignal/services/name-index";
import { refreshBrowser } from "@/nextsignal/services/catalog-browser";
import { pool } from "@/nextsignal/services/database";

try {
  const result = await reindexProductNames((progress) =>
    console.info(progress),
  );
  if (result === null)
    throw new Error(
      "The browser index is currently being refreshed or rebuilt; retry shortly",
    );
  const refreshed = await refreshBrowser();
  console.info({ ...result, browser_refreshed: refreshed });
} finally {
  await pool.end();
}
