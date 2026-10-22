import { settings } from "@/nextsignal/config";
import { SESSION_COOKIE } from "@/nextsignal/adapters/auth";
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && !settings.auth.allowed_origins.includes(origin))
    return new Response(null, { status: 403 });
  return Response.json(
    { ok: true },
    {
      headers: {
        "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      },
    },
  );
}
