import { afterEach, afterAll, it, expect, vi } from "vitest";
import { POST } from "@/app/api/auth/login/route";
import { services } from "@/nextsignal/services";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";

afterEach(() => vi.restoreAllMocks());
afterAll(() => pool.end());

function request(body: unknown, origin = settings.auth.allowed_origins[0]) {
  return new Request(new URL("/api/auth/login", origin), {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}
const credentials = { username: "admin", password: "test-password" };

it("reports a sign-in service outage without blaming credentials or exposing internal errors", async () => {
  vi.spyOn(services.operations, "login").mockRejectedValueOnce(
    new Error("Private database connection failure"),
  );
  const response = await POST(request(credentials));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    ok: false,
    message: "Sign-in is temporarily unavailable. Please try again shortly.",
  });
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("reports wrong credentials without suggesting that a limit was reached", async () => {
  vi.spyOn(services.operations, "login").mockResolvedValueOnce({
    status: "invalid",
  });
  const response = await POST(request(credentials));
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    ok: false,
    message: "Incorrect username or password.",
  });
  expect(response.headers.get("set-cookie")).toBeNull();
});

it("keeps malformed credentials as validation failures", async () => {
  const login = vi.spyOn(services.operations, "login");
  const response = await POST(request({ username: 123 }));
  expect(response.status).toBe(400);
  expect(login).not.toHaveBeenCalled();
  expect(response.headers.get("set-cookie")).toBeNull();
});

it("sets the session cookie only after successful authentication", async () => {
  vi.spyOn(services.operations, "login").mockResolvedValueOnce({
    status: "authenticated",
    token: "opaque-test-session",
  });
  const response = await POST(request(credentials));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get("set-cookie")).toContain(
    "mkd_session=opaque-test-session; HttpOnly; SameSite=Strict; Path=/;",
  );
});

it("reports an actual client limit as 429 with a retry time", async () => {
  vi.spyOn(services.operations, "login").mockResolvedValueOnce({
    status: "limited",
    retry_after_seconds: 120,
  });
  const response = await POST(request(credentials));
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("120");
  expect((await response.json()).message).toContain("Too many failed");
  expect(response.headers.get("set-cookie")).toBeNull();
});

it("still rejects a foreign origin before authenticating", async () => {
  const login = vi.spyOn(services.operations, "login");
  const response = await POST(
    request(credentials, "https://unrelated.example"),
  );
  expect(response.status).toBe(403);
  expect(login).not.toHaveBeenCalled();
});
