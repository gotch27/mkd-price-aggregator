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
const anyProduct = await (
  await fetch(
    new URL("/api/operations?view=universal&search=&page=1&size=1", base),
    { headers: { cookie } },
  )
).json();
if (anyProduct.data.rows.length) {
  const id = anyProduct.data.rows[0].product_id;
  const url = new URL(`/api/products/${id}/matching?page=1&search=`, base);
  assert.equal((await fetch(url)).status, 401);
  const manual = await (await fetch(url, { headers: { cookie } })).json();
  assert.ok(
    manual.ok && manual.data.group && Array.isArray(manual.data.group.members),
  );
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ action: "connect" }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: {
          cookie,
          origin: "https://unrelated.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "connect" }),
      })
    ).status,
    403,
  );
}
assert.equal(
  (
    await fetch(new URL("/api/tasks", base), {
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
for (const path of [
  "/api/brands?search=&page=1&size=1",
  "/api/brands/options",
  "/api/task-settings",
  "/api/tasks?page=1&size=1",
  "/api/task-settings/history?page=1&size=1",
  "/api/task-settings/schedule?cron=0%2012%20*%20*%201",
  "/api/tasks/categories?retailer=kam&source_id=",
  "/api/review/categories?status=needs_review&search=&availability=available&page=1&size=1",
  "/api/review/agent-sessions",
  "/api/review/brand-sessions",
]) {
  assert.equal((await fetch(new URL(path, base))).status, 401, path);
  const response: Response = await fetch(new URL(path, base), {
    headers: { cookie },
  });
  assert.equal(response.status, 200, path);
  assert.equal((await response.json()).ok, true, path);
}
for (const path of [
  "/api/brands",
  "/api/tasks",
  "/api/review/agent-sessions",
  "/api/review/brand-sessions",
]) {
  const response: Response = await fetch(new URL(path, base), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ kind: "match" }),
  });
  assert.equal(response.status, 400, path);
}
assert.equal(
  (
    await fetch(new URL("/api/task-settings", base), {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ revision: "invalid" }),
    })
  ).status,
  400,
);
console.info(
  "HTTP smoke passed: authentication, dashboard/settings/task reads, invalid task starts, and cross-origin rejection. No task was started.",
);
