import { logEvent } from "@/nextsignal/adapters/log-context";
import { settings } from "@/nextsignal/config";
import { pool, transaction } from "./database";
import { createHmac } from "node:crypto";
import type { LoginResult } from "@/nextsignal/domain/authentication";
import { seedRetailers } from "./catalog-repository";
import { createRun } from "@/nextsignal/services/run-repository";
import { safeEqual, sessionToken } from "@/nextsignal/adapters/auth";
import {
  startPending,
  controlCampaign,
} from "@/nextsignal/services/matching-repository";
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
    const run = await createRun("discover", key, null, null);
    runs.push(run);
    await logEvent(
      "info",
      "catalog.import.requested",
      "Store price import requested",
      { run_id: run.id, retailer: key },
    );
  }
  return runs;
}
export async function retryRun(id: string) {
  const old = (await pool.query("SELECT * FROM runs WHERE id=$1", [id]))
    .rows[0];
  if (!old || !["failed", "quarantined"].includes(old.status))
    throw new Error("Only failed or quarantined runs may be retried");
  const run = await createRun(
    old.kind,
    old.retailer,
    old.source_id,
    old.kind === "match" ? (old.parent_id ?? old.id) : old.parent_id,
  );
  await logEvent(
    "info",
    "catalog.run.retry_requested",
    "Failed task retry requested",
    {
      run_id: run.id,
      original_run_id: old.id,
      kind: old.kind,
      retailer: old.retailer,
      source_id: old.source_id,
    },
  );
  return run;
}

export async function retryMatching(
  sourceId: string | null,
  action: "process_pending" | "pause" | "resume" = "process_pending",
) {
  await logEvent(
    "info",
    "matching.command.received",
    "Matching task command received",
    { action, source_id: sourceId },
  );
  if (action === "pause") return controlCampaign(action, sourceId);
  if (!settings.matching.automatic_enabled) {
    await logEvent(
      "info",
      "matching.command.disabled",
      "Matching command ignored because automatic matching is disabled",
      { action, source_id: sourceId },
    );
    return {
      state: "disabled",
      reason: "Automatic matching awaits the agreed dataset evaluation",
    };
  }
  if (action === "resume") await controlCampaign(action, sourceId);
  const campaign = await startPending(sourceId);
  await logEvent(
    "info",
    "matching.command.completed",
    "Matching command handled",
    {
      action,
      source_id: sourceId,
      campaign_id: campaign?.id ?? null,
      campaign_state: campaign?.state ?? "waiting",
    },
  );
  return campaign;
}

export async function checkHealth() {
  await pool.query("SELECT 1");
}
export async function login(
  username: string,
  password: string,
  client: string,
): Promise<LoginResult> {
  const key = createHmac("sha256", settings.auth.session_secret)
    .update(JSON.stringify([settings.auth.username, client]))
    .digest("hex");
  const result = await transaction<LoginResult>(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `login:${key}`,
    ]);
    const previous = (
      await c.query(
        `SELECT attempts,window_start>=now()-$2*interval '1 millisecond' AS active,
    greatest(1,ceil(extract(epoch FROM window_start+$2*interval '1 millisecond'-now())))::int retry_after_seconds FROM login_attempts WHERE key=$1 FOR UPDATE`,
        [key, settings.auth.login_window_ms],
      )
    ).rows[0];
    if (previous?.active && previous.attempts >= settings.auth.login_attempts)
      return {
        status: "limited",
        retry_after_seconds: previous.retry_after_seconds,
      };
    const correctUser = safeEqual(username, settings.auth.username),
      correctPassword = safeEqual(password, settings.auth.password);
    if (correctUser && correctPassword) {
      await c.query("DELETE FROM login_attempts WHERE key=$1", [key]);
      return { status: "authenticated", token: sessionToken() };
    }
    await c.query(
      `INSERT INTO login_attempts(key,attempts,window_start) VALUES($1,1,now()) ON CONFLICT(key) DO UPDATE SET
   attempts=CASE WHEN login_attempts.window_start<now()-$2*interval '1 millisecond' THEN 1 ELSE login_attempts.attempts+1 END,
   window_start=CASE WHEN login_attempts.window_start<now()-$2*interval '1 millisecond' THEN now() ELSE login_attempts.window_start END`,
      [key, settings.auth.login_window_ms],
    );
    return { status: "invalid" };
  });
  await logEvent(
    result.status === "authenticated" ? "info" : "warn",
    `auth.login.${result.status}`,
    result.status === "authenticated"
      ? "Signed in successfully"
      : result.status === "limited"
        ? "Sign-in temporarily limited after failed passwords"
        : "Sign-in rejected: incorrect username or password",
    {
      account: settings.auth.username,
      client_key: key.slice(0, 12),
      ...(result.status === "limited"
        ? { retry_after_seconds: result.retry_after_seconds }
        : {}),
    },
  );
  return result;
}
