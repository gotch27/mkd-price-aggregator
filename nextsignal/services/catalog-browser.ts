import { pool, withLock } from "@/nextsignal/services/database";

export async function browserStatus() {
  const status = (
    await pool.query(
      `SELECT refreshed_at, completed_at, completed_at::text AS snapshot_key, requested_at > refreshed_at AS dirty
     FROM catalog_browser_state WHERE key='catalog'`,
    )
  ).rows[0];
  if (!status)
    throw new Error("Catalog browser has not been initialized; run migrations");
  return status;
}

export async function refreshBrowser() {
  return withLock("catalog-browser-refresh", async () => {
    const status = await browserStatus();
    if (!status.dirty) return false;
    // Rebuild once the current import wave has finished, rather than once per
    // branch or browser request. Authoritative offers stay immediately current.
    const active = await pool.query(
      "SELECT 1 FROM runs WHERE kind IN ('discover','catalog') AND status IN ('pending','queued','running') LIMIT 1",
    );
    if (active.rowCount) return false;
    const started = (await pool.query("SELECT clock_timestamp() AS time"))
      .rows[0].time;
    await pool.query("REFRESH MATERIALIZED VIEW CONCURRENTLY catalog_browser");
    await pool.query("ANALYZE catalog_browser");
    await pool.query(
      "UPDATE catalog_browser_state SET refreshed_at=$1,completed_at=clock_timestamp() WHERE key='catalog'",
      [started],
    );
    return true;
  });
}
