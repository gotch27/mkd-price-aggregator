import { settings } from "@/nextsignal/config";
import { pool } from "./database";
import { seedRetailers } from "./catalog-repository";
import { createRun } from "@/nextsignal/services/run-repository";
import { safeEqual, sessionToken } from "@/nextsignal/adapters/auth";
export { readDashboard } from "@/nextsignal/services/dashboard-read";
export {
  detailsForProduct,
  offersForProduct,
} from "@/nextsignal/services/product-browser";
export async function requestIngestion(retailer: string | null) {
  await seedRetailers();
  const keys = retailer
    ? [retailer]
    : Object.keys(settings.sources).filter((k) => settings.sources[k].enabled);
  const runs = [];
  for (const key of keys) {
    if (!settings.sources[key]?.enabled)
      throw new Error(`Retailer is not enabled: ${key}`);
    runs.push(await createRun("discover", key, null, null));
  }
  return runs;
}
export async function retryRun(id: string) {
  const old = (await pool.query("SELECT * FROM runs WHERE id=$1", [id]))
    .rows[0];
  if (!old || !["failed", "quarantined"].includes(old.status))
    throw new Error("Only failed or quarantined runs may be retried");
  return createRun(old.kind, old.retailer, old.source_id, old.parent_id);
}

export async function retryMatching(sourceId: string | null) {
  // Reopen unresolved identities while keeping established connections intact.
  await pool.query(
    `UPDATE listings SET next_match_at=now(),matched_hash=NULL
     WHERE match_status='separate' AND (matched_hash IS NOT NULL OR next_match_at>now())
       AND EXISTS(SELECT 1 FROM offers o WHERE o.listing_id=listings.id AND ($1::uuid IS NULL OR o.source_id=$1))`,
    [sourceId],
  );
  return createRun("match", null, sourceId, null);
}

export async function checkHealth() {
  await pool.query("SELECT 1");
}
export async function login(username: string, password: string) {
  const { rows } = await pool.query(
    `INSERT INTO login_attempts(key,attempts,window_start) VALUES($1,1,now()) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_attempts.window_start<now()-$2*interval '1 millisecond' THEN 1 ELSE login_attempts.attempts+1 END,window_start=CASE WHEN login_attempts.window_start<now()-$2*interval '1 millisecond' THEN now() ELSE login_attempts.window_start END RETURNING attempts`,
    [settings.auth.username, settings.auth.login_window_ms],
  );
  if (rows[0].attempts > settings.auth.login_attempts) return null;
  if (
    !safeEqual(username, settings.auth.username) ||
    !safeEqual(password, settings.auth.password)
  )
    return null;
  await pool.query("DELETE FROM login_attempts WHERE key=$1", [
    settings.auth.username,
  ]);
  return sessionToken();
}
