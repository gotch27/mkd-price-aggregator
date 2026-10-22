import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { settings } from "@/nextsignal/config";
const configuration = JSON.parse(await readFile("config/testing.json", "utf8"));
if (typeof configuration.web_url !== "string")
  throw new Error("Missing testing.web_url");
const base = configuration.web_url;
assert.equal((await fetch(new URL("/api/health", base))).status, 200);
assert.equal(
  (
    await fetch(
      new URL("/api/operations?view=summary&search=&page=1&size=1", base),
    )
  ).status,
  401,
);
const login = await fetch(new URL("/api/auth/login", base), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: settings.auth.username,
    password: settings.auth.password,
  }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie);
for (const view of [
  "summary",
  "sources",
  "products",
  "universal",
  "runs",
  "logs",
  "decisions",
]) {
  const response: Response = await fetch(
    new URL(
      `/api/operations?view=${view}&search=&page=1&size=${settings.dashboard.page_size}`,
      base,
    ),
    { headers: { cookie } },
  );
  assert.equal(response.status, 200, view);
  const result = await response.json();
  assert.equal(result.ok, true, view);
}
const grouped = await (
  await fetch(
    new URL(
      "/api/operations?view=universal&search=&page=1&size=1&match_filter=matched",
      base,
    ),
    { headers: { cookie } },
  )
).json();
if (grouped.data.rows.length) {
  const id = grouped.data.rows[0].product_id;
  assert.equal((await fetch(new URL(`/api/products/${id}`, base))).status, 401);
  const details = await (
    await fetch(new URL(`/api/products/${id}`, base), { headers: { cookie } })
  ).json();
  assert.ok(
    details.ok &&
      Array.isArray(details.data.listings) &&
      Array.isArray(details.data.decisions),
  );
}
assert.equal(
  (
    await fetch(
      new URL("/api/products/00000000-0000-4000-8000-000000000000", base),
      { headers: { cookie } },
    )
  ).status,
  404,
);
assert.equal(
  (
    await fetch(new URL("/api/matching", base), {
      method: "POST",
      headers: {
        cookie,
        origin: "https://unrelated.example",
        "content-type": "application/json",
      },
      body: '{"source_id":null}',
    })
  ).status,
  403,
);
assert.equal(
  (
    await fetch(
      new URL("/api/operations?view=products&search=&page=0&size=1", base),
      { headers: { cookie } },
    )
  ).status,
  400,
);
console.info(
  "HTTP smoke passed: authentication, all dashboard views, invalid input, and cross-origin rejection.",
);
