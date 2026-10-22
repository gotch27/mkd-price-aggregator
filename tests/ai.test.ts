import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import { aiRequest, equivalent } from "@/nextsignal/services/ai";
const original = structuredClone(settings.matching.ai);
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Dedicated test database required");
  await pool.query("DELETE FROM ai_cache");
  await pool.query("DELETE FROM ai_usage");
  Object.assign(settings.matching.ai, original, {
    enabled: true,
    api_key: "test-key",
    run_budget_usd: null,
    monthly_budget_usd: null,
  });
  vi.restoreAllMocks();
});
afterAll(async () => {
  Object.assign(settings.matching.ai, original);
  vi.restoreAllMocks();
  await pool.end();
});
it("handles refusals without linking listings", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        answers: [{ name: "exact_product", type: "refusal" }],
        usage: { input_tokens: 100, output_tokens: 0 },
      }),
    ),
  );
  expect(await equivalent({ test: "refusal" }, null)).toBeNull();
});
it("defers rate limits and records the failed reservation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("", { status: 429 })),
  );
  await expect(
    aiRequest("decisions", { input: "rate limit" }, null),
  ).rejects.toThrow("HTTP 429");
  expect((await pool.query("SELECT status FROM ai_usage")).rows[0].status).toBe(
    "error-reserved",
  );
});
it("continues with pending matching when the provider is unavailable", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("network unavailable")),
  );
  await expect(
    aiRequest("decisions", { input: "outage" }, null),
  ).rejects.toThrow("network unavailable");
});
it("checks an explicitly configured budget before a paid request", async () => {
  settings.matching.ai.monthly_budget_usd = 0.00000001;
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    aiRequest("decisions", { input: "budget test" }, null),
  ).rejects.toThrow("spending cap");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("shares the ingestion budget across sibling matching jobs", async () => {
  const root = (
    await pool.query(
      "INSERT INTO runs(kind,status) VALUES('discover','success') RETURNING id",
    )
  ).rows[0].id;
  const jobs = (
    await pool.query(
      "INSERT INTO runs(kind,parent_id,status) VALUES('match',$1,'success'),('match',$1,'pending') RETURNING id",
      [root],
    )
  ).rows;
  await pool.query(
    "INSERT INTO ai_usage(run_id,endpoint,model,status,input_tokens,output_tokens,cost_usd) VALUES($1,'decisions','test','success',1,0,0.01)",
    [jobs[0].id],
  );
  settings.matching.ai.run_budget_usd = 0.01;
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    aiRequest(
      "decisions",
      { input: "another batch in the same ingestion" },
      jobs[1].id,
    ),
  ).rejects.toThrow("spending cap");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("reuses cached decisions without paying twice", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      answers: [
        { name: "exact_product", type: "predicate", probability: 0.999 },
      ],
      usage: { input_tokens: 100, output_tokens: 0 },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  expect(await equivalent({ test: "cached" }, null)).toBe(0.999);
  expect(await equivalent({ test: "cached" }, null)).toBe(0.999);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(
    (await pool.query("SELECT cost_usd FROM ai_usage")).rows[0].cost_usd,
  ).toBe("0.00001000");
});
it("enforces request-count limits before sending paid requests", async () => {
  settings.matching.ai.max_requests_per_run = 1;
  await pool.query(
    "INSERT INTO ai_usage(endpoint,model,status,input_tokens,output_tokens,cost_usd) VALUES('decisions','test','success',1,0,0)",
  );
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    aiRequest("decisions", { input: "limited" }, null),
  ).rejects.toThrow("request limit");
  expect(fetchMock).not.toHaveBeenCalled();
});
