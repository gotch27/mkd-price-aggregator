import { createNextRoute } from "@gotch/nextsignal/next";
import { app } from "@/nextsignal/app";
import { settings } from "@/nextsignal/config";
import { SESSION_COOKIE } from "@/nextsignal/adapters/auth";
export const runtime = "nodejs";
const login = createNextRoute(app, "auth.login");
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && !settings.auth.allowed_origins.includes(origin))
    return Response.json({ ok: false }, { status: 403 });
  const response = await login(request);
  const result = await response.json();
  if (!result.ok) {
    const limited = result.errors?.[0]?.code === "auth.rate_limited";
    return Response.json(
      {
        ok: false,
        message:
          response.status >= 500
            ? "Sign-in is temporarily unavailable. Please try again shortly."
            : limited
              ? result.errors[0].message
              : response.status === 401
                ? "Incorrect username or password."
                : "Enter a valid username and password.",
      },
      {
        status: response.status >= 500 ? 503 : limited ? 429 : response.status,
        headers: {
          "cache-control": "no-store",
          ...(limited
            ? {
                "retry-after": String(
                  result.errors[0].details.retry_after_seconds,
                ),
              }
            : {}),
        },
      },
    );
  }
  return Response.json(
    { ok: true },
    {
      headers: {
        "set-cookie": `${SESSION_COOKIE}=${result.data.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${settings.auth.session_hours * 3600}${settings.auth.secure_cookie ? "; Secure" : ""}`,
        "cache-control": "no-store",
      },
    },
  );
}
