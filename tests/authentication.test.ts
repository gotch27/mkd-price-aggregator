import { createHmac } from "node:crypto";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import { login } from "@/nextsignal/services/operations";
import { loginClient, validSession } from "@/nextsignal/adapters/auth";
import { withLogContext } from "@/nextsignal/adapters/log-context";

const first = "192.0.2.1",
  second = "192.0.2.2";
function key(client: string) {
  return createHmac("sha256", settings.auth.session_secret)
    .update(JSON.stringify([settings.auth.username, client]))
    .digest("hex");
}
const attempt = (
  client = first,
  password = "incorrect-test-password",
  username = settings.auth.username,
) => login(username, password, client);
const correct = (client = first) => attempt(client, settings.auth.password);

beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  await pool.query("TRUNCATE login_attempts,logs");
});
afterAll(() => pool.end());

it("counts failed passwords per client and does not extend a blocked window", async () => {
  for (let i = 0; i < settings.auth.login_attempts; i++)
    expect((await attempt()).status).toBe("invalid");
  const before = (
    await pool.query("SELECT * FROM login_attempts WHERE key=$1", [key(first)])
  ).rows[0];
  const blocked = await correct();
  expect(blocked.status).toBe("limited");
  if (blocked.status === "limited") {
    expect(blocked.retry_after_seconds).toBeGreaterThan(0);
    expect(blocked.retry_after_seconds).toBeLessThanOrEqual(
      Math.ceil(settings.auth.login_window_ms / 1000),
    );
  }
  expect((await correct(second)).status).toBe("authenticated");
  const after = (
    await pool.query("SELECT * FROM login_attempts WHERE key=$1", [key(first)])
  ).rows[0];
  expect(after).toEqual(before);
});

it("clears only that client's failures and never counts successful logins", async () => {
  await attempt();
  await attempt(second);
  for (let i = 0; i < settings.auth.login_attempts + 1; i++) {
    const result = await correct();
    expect(result.status).toBe("authenticated");
    if (result.status === "authenticated")
      expect(validSession(result.token)).toBe(true);
  }
  expect(
    (await pool.query("SELECT key,attempts FROM login_attempts")).rows,
  ).toEqual([{ key: key(second), attempts: 1 }]);
});

it("resets an expired window and shares the client guard across attempted usernames", async () => {
  await pool.query(
    "INSERT INTO login_attempts VALUES($1,$2,now()-$3*interval '1 millisecond')",
    [
      key(first),
      settings.auth.login_attempts,
      settings.auth.login_window_ms + 1000,
    ],
  );
  expect(
    (await attempt(first, "incorrect-test-password", "another-user")).status,
  ).toBe("invalid");
  expect(
    (
      await pool.query("SELECT attempts FROM login_attempts WHERE key=$1", [
        key(first),
      ])
    ).rows[0].attempts,
  ).toBe(1);
  expect((await correct()).status).toBe("authenticated");
});

it("serializes concurrent failures so they cannot race past the limit", async () => {
  const results = await Promise.all(
    Array.from({ length: settings.auth.login_attempts + 3 }, () => attempt()),
  );
  expect(results.filter((r) => r.status === "invalid")).toHaveLength(
    settings.auth.login_attempts,
  );
  expect(results.filter((r) => r.status === "limited")).toHaveLength(3);
  expect(
    (
      await pool.query("SELECT attempts FROM login_attempts WHERE key=$1", [
        key(first),
      ])
    ).rows[0].attempts,
  ).toBe(settings.auth.login_attempts);
});

it("does not carry an old account-wide lock into client-scoped protection", async () => {
  await pool.query("INSERT INTO login_attempts VALUES($1,19,now())", [
    settings.auth.username,
  ]);
  expect((await correct()).status).toBe("authenticated");
});

it("records reasons through the log adapter without credentials, sessions, or raw addresses", async () => {
  const warn = vi.fn(),
    info = vi.fn();
  let session = "";
  await withLogContext(
      { logger: { warn, info, error: vi.fn() }, process: "auth.login" },
    async () => {
      await attempt();
      const result = await correct();
      if (result.status === "authenticated") session = result.token;
    },
  );
  expect(warn.mock.calls[0][0].data.event).toBe("auth.login.invalid");
  expect(info.mock.calls[0][0].data.event).toBe("auth.login.authenticated");
  const serialized = JSON.stringify([warn.mock.calls, info.mock.calls]);
  for (const sensitive of [
    settings.auth.password,
    settings.auth.session_secret,
    session,
    first,
    "incorrect-test-password",
  ])
    expect(serialized.includes(sensitive)).toBe(false);
});

it("accepts only a valid address from the configured proxy header", () => {
  expect(
    loginClient({ [settings.auth.login_client_header]: ` ${first} ` }),
  ).toBe(first);
  expect(
    loginClient({ [settings.auth.login_client_header]: "2001:DB8::1" }),
  ).toBe("2001:db8::1");
  for (const value of ["", "arbitrary", `${first}, ${second}`])
    expect(loginClient({ [settings.auth.login_client_header]: value })).toBe(
      "unidentified",
    );
  expect(loginClient({ "x-client-id": first })).toBe("unidentified");
  expect(loginClient(undefined)).toBe("unidentified");
});
