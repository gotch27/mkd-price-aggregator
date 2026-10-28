import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  authFail,
  forbidden,
  value,
  type AuthAdapter,
} from "@gotch/nextsignal";
import { settings } from "@/nextsignal/config";
export const SESSION_COOKIE = "mkd_session";
// The deployment exposes web through a trusted reverse proxy. Configure the
// proxy-owned address header; never accept a client identifier from the body.
export function loginClient(headers: Record<string, string> | undefined) {
  const address = headers?.[settings.auth.login_client_header]?.trim();
  return address && isIP(address) ? address.toLowerCase() : "unidentified";
}
const digest = (value: string) => createHash("sha256").update(value).digest();
export const safeEqual = (a: string, b: string) =>
  timingSafeEqual(digest(a), digest(b));
export function sessionToken() {
  const body = Buffer.from(
    JSON.stringify({
      username: settings.auth.username,
      expires: Date.now() + settings.auth.session_hours * 3600000,
    }),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", settings.auth.session_secret).update(body).digest("base64url")}`;
}
export function validSession(token: string) {
  const [body, signature, ...extra] = token.split(".");
  if (!body || !signature || extra.length) return false;
  const expected = createHmac("sha256", settings.auth.session_secret)
    .update(body)
    .digest("base64url");
  if (!safeEqual(signature, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    return (
      data.username === settings.auth.username &&
      typeof data.expires === "number" &&
      data.expires > Date.now()
    );
  } catch {
    return false;
  }
}
export function cookieToken(cookie: string) {
  const part = cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return part ? part.slice(SESSION_COOKIE.length + 1) : "";
}
export const authAdapter: AuthAdapter = {
  requireUser(ctx) {
    const cookie = ctx.request?.headers.cookie;
    if (!cookie || !validSession(cookieToken(cookie))) return authFail();
    if (ctx.request && ctx.request.method !== "GET") {
      const origin = ctx.request.headers.origin;
      if (origin && !settings.auth.allowed_origins.includes(origin))
        return forbidden("Origin mismatch");
    }
    return value({ username: settings.auth.username });
  },
};

// Temporary machine-agent access is scoped to category-review processes. The
// ordinary auth adapter deliberately remains cookie-only for every other API.
export function requireAgentReviewUser(
  ctx: Parameters<NonNullable<AuthAdapter["requireUser"]>>[0],
) {
  const header = ctx.request?.headers.authorization;
  if (header === undefined) return authAdapter.requireUser!(ctx);
  const bearer = header.match(/^Bearer[ \t]+(.+)$/i);
  if (!bearer || !safeEqual(bearer[1], settings.auth.password))
    return authFail("Invalid agent review credentials");
  if (ctx.request?.method !== "GET") {
    const origin = ctx.request?.headers.origin;
    if (origin && !settings.auth.allowed_origins.includes(origin))
      return forbidden("Origin mismatch");
  }
  return value({ username: settings.auth.username });
}
