import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import { fetchBytes } from "@/nextsignal/services/http";
import {
  assertHostReady,
  blockedRetailers,
  recordHostFailure,
  recordHostSuccess,
} from "@/nextsignal/services/source-health";
import { SourceDeferred } from "@/nextsignal/domain/types";

const initial = structuredClone(settings.http);
const host = new URL(settings.sources.stokomak.url).host;
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  await pool.query("TRUNCATE host_limits,logs");
  settings.http.host_intervals_ms[host] = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("complete")),
  );
});
afterEach(() => {
  Object.assign(settings.http, structuredClone(initial));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => pool.end());

it("cools a failing host and prevents calls without spending more download attempts", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("socket disconnected");
    }),
  );
  for (let i = 0; i < settings.http.cooldown.failure_threshold; i++)
    await expect(fetchBytes(settings.sources.stokomak.url)).rejects.toThrow(
      "socket disconnected",
    );
  await expect(
    fetchBytes(settings.sources.stokomak.url),
  ).rejects.toBeInstanceOf(SourceDeferred);
  expect(fetch).toHaveBeenCalledTimes(settings.http.cooldown.failure_threshold);
  expect(await blockedRetailers()).toEqual([
    { retailer: "stokomak", until: expect.any(String) },
  ]);
  const until = (await blockedRetailers())[0].until;
  expect(Date.parse(until) - Date.now()).toBeGreaterThan(
    settings.http.cooldown.base_ms - 2000,
  );
});

it.each(["stokomak", "zito"] as const)(
  "recognizes %s's HTTP-200 upstream failure before marking its host healthy",
  async (retailer) => {
    const sourceHost = new URL(settings.sources[retailer].url).host;
    settings.http.host_intervals_ms[sourceHost] = 1;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            "\uFEFFError fetching organizations: Failed to connect to 172.16.19.26 port 80: Timed out",
            { status: 200 },
          ),
      ),
    );
    await expect(
      fetchBytes(settings.sources[retailer].url),
    ).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining(
        "its internal server connection timed out",
      ),
      diagnostics: {
        status: 200,
        phase: "provider_response",
        provider_operation: "organizations",
        provider_failure: "connection_timeout",
      },
    });
    const state = (
      await pool.query(
        "SELECT consecutive_failures,last_success_at FROM host_limits WHERE host=$1",
        [sourceHost],
      )
    ).rows[0];
    expect(state.consecutive_failures).toBe(1);
    expect(state.last_success_at).toBeNull();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("valid catalog"));
    expect(
      (await fetchBytes(settings.sources[retailer].url)).bytes.toString(),
    ).toBe("valid catalog");
    expect(
      (
        await pool.query(
          "SELECT consecutive_failures FROM host_limits WHERE host=$1",
          [sourceHost],
        )
      ).rows[0].consecutive_failures,
    ).toBe(0);
  },
);

it("accumulates HTTP-200 provider failures into the shared host cooldown", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response("Error fetching products: Connection refused"),
    ),
  );
  for (let n = 0; n < settings.http.cooldown.failure_threshold; n++)
    await expect(
      fetchBytes(settings.sources.stokomak.url),
    ).rejects.toMatchObject({
      retryable: true,
      diagnostics: {
        provider_operation: "products",
        provider_failure: "connection_failed",
      },
    });
  await expect(
    fetchBytes(settings.sources.stokomak.url),
  ).rejects.toBeInstanceOf(SourceDeferred);
  expect(fetch).toHaveBeenCalledTimes(settings.http.cooldown.failure_threshold);
});

it.each([
  "<table><tr><td>Error fetching organizations: Failed to connect: Timed out</td></tr></table>",
  JSON.stringify({ name: "Error fetching products: Connection refused" }),
  "Error fetching organizations: Unsupported API version",
])(
  "does not reinterpret product text or unknown provider errors as a known connection outage",
  async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    expect(
      (await fetchBytes(settings.sources.stokomak.url)).bytes.toString(),
    ).toBe(body);
  },
);

it("counts failures atomically across workers and caps longer cooldowns", async () => {
  await pool.query("INSERT INTO host_limits(host,next_at) VALUES($1,now())", [
    host,
  ]);
  await Promise.all(
    Array.from({ length: 30 }, () => recordHostFailure(host, null)),
  );
  const row = (
    await pool.query(
      "SELECT consecutive_failures,cooldown_until FROM host_limits WHERE host=$1",
      [host],
    )
  ).rows[0];
  expect(row.consecutive_failures).toBe(30);
  expect(
    new Date(row.cooldown_until).getTime() - Date.now(),
  ).toBeLessThanOrEqual(settings.http.cooldown.max_ms + 1000);
});

it("allows recovery after cooldown and resets the shared failure count after a complete response", async () => {
  await pool.query(
    "INSERT INTO host_limits(host,next_at,consecutive_failures,cooldown_until) VALUES($1,now(),$2,now()-interval '1 second')",
    [host, settings.http.cooldown.failure_threshold],
  );
  expect(
    (await fetchBytes(settings.sources.stokomak.url)).bytes.toString(),
  ).toBe("complete");
  const row = (
    await pool.query(
      "SELECT consecutive_failures,cooldown_until,last_success_at FROM host_limits WHERE host=$1",
      [host],
    )
  ).rows[0];
  expect(row.consecutive_failures).toBe(0);
  expect(row.cooldown_until).toBeNull();
  expect(row.last_success_at).toBeInstanceOf(Date);
});

it("ends stalled response bodies at the idle timeout and retains partial byte diagnostics", async () => {
  settings.http.response_idle_timeout_ms = 15;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("part"));
            },
          }),
          { headers: { "content-length": "100" } },
        ),
    ),
  );
  await expect(fetchBytes(settings.sources.stokomak.url)).rejects.toMatchObject(
    {
      retryable: true,
      diagnostics: {
        phase: "body_idle",
        received_bytes: 4,
        expected_bytes: 100,
      },
    },
  );
});

it("rejects an incomplete uncompressed response before parsing or publishing", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("short", { headers: { "content-length": "100" } }),
    ),
  );
  await expect(fetchBytes(settings.sources.stokomak.url)).rejects.toMatchObject(
    { retryable: true, message: expect.stringContaining("5 of 100 bytes") },
  );
});

it("does not compare decoded response bytes against compressed content length", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("decoded", {
          headers: { "content-length": "3", "content-encoding": "gzip" },
        }),
    ),
  );
  expect(
    (await fetchBytes(settings.sources.stokomak.url)).bytes.toString(),
  ).toBe("decoded");
});

it("honors Retry-After immediately across workers and does not cool unrelated stores", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "900" },
        }),
    ),
  );
  await expect(fetchBytes(settings.sources.stokomak.url)).rejects.toMatchObject(
    { retryable: true },
  );
  const blocked = await blockedRetailers();
  expect(blocked).toEqual([
    { retailer: "stokomak", until: expect.any(String) },
  ]);
  expect(Date.parse(blocked[0].until) - Date.now()).toBeGreaterThan(899000);
  await expect(
    fetchBytes(settings.sources.stokomak.url),
  ).rejects.toBeInstanceOf(SourceDeferred);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps invalid responses and byte-limit errors out of the network cooldown count", async () => {
  settings.http.max_bytes = 2;
  await expect(fetchBytes(settings.sources.stokomak.url)).rejects.toMatchObject(
    { retryable: false },
  );
  const row = (
    await pool.query(
      "SELECT consecutive_failures FROM host_limits WHERE host=$1",
      [host],
    )
  ).rows[0];
  expect(row.consecutive_failures).toBe(0);
});

it("does not let an older successful request erase a newer failure or Retry-After", async () => {
  await pool.query("INSERT INTO host_limits(host,next_at) VALUES($1,now())", [
    host,
  ]);
  const observed = await assertHostReady(host);
  await recordHostFailure(host, new Date(Date.now() + 900000));
  await recordHostSuccess(host, observed);
  expect(await blockedRetailers()).toEqual([
    { retailer: "stokomak", until: expect.any(String) },
  ]);
  expect(
    (
      await pool.query(
        "SELECT consecutive_failures FROM host_limits WHERE host=$1",
        [host],
      )
    ).rows[0].consecutive_failures,
  ).toBe(1);
});

it("releases failed response bodies when saving health fails and pauses safely", async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(new ReadableStream({ cancel }), { status: 503 }),
    ),
  );
  const query = pool.query.bind(pool);
  vi.spyOn(pool, "query").mockImplementation(((
    ...args: Parameters<typeof pool.query>
  ) => {
    if (String(args[0]).includes("consecutive_failures=consecutive_failures+1"))
      return Promise.reject(new Error("health database unavailable"));
    return query(...args);
  }) as typeof pool.query);
  await expect(fetchBytes(settings.sources.stokomak.url)).rejects.toThrow(
    "store download health cannot be saved",
  );
  expect(cancel).toHaveBeenCalledTimes(1);
});
