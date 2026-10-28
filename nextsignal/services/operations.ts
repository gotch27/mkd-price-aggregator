import { logEvent } from "@/nextsignal/adapters/log-context";
import { settings } from "@/nextsignal/config";
import { pool, transaction } from "./database";
import { createHmac } from "node:crypto";
import type { LoginResult } from "@/nextsignal/domain/authentication";
import { safeEqual, sessionToken } from "@/nextsignal/adapters/auth";
export { readDashboard } from "@/nextsignal/services/dashboard-read";
export {
  detailsForProduct,
  offersForProduct,
} from "@/nextsignal/services/product-browser";
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
