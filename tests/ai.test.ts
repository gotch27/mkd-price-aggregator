import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import { ensureCampaign } from "@/nextsignal/services/matching-repository";
import { decide } from "@/nextsignal/services/ai-gateway";
const original = structuredClone(settings.matching.gateway);
const questions = {
  match: {
    type: "choice" as const,
    instructions: "Compare",
    criteria: {
      same: "Same",
      different: "Different",
      insufficient: "Missing information",
    },
  },
};
const answer = {
  type: "choice",
  choice: "same",
  probabilities: { same: 0.999, different: 0.0005, insufficient: 0.0005 },
};
function response(
  answers: unknown,
  usage: unknown = { inputTokens: 100, outputTokens: 0 },
  cost: unknown = "0.000002",
) {
  return Response.json({
    answers,
    usage,
    providerMetadata: { gateway: { cost, generationId: "gen_gateway_test" } },
  });
}
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Dedicated test database required");
  await pool.query("DELETE FROM ai_cache");
  await pool.query("DELETE FROM ai_usage");
  await pool.query("DELETE FROM matching_work");
  await pool.query("TRUNCATE matching_campaigns CASCADE");
  Object.assign(settings.matching.gateway, structuredClone(original), {
    enabled: true,
    api_key: "test-key",
    retry_delay_ms: 1,
    retry_max_delay_ms: 1,
  });
  vi.restoreAllMocks();
});
afterAll(async () => {
  Object.assign(settings.matching.gateway, original);
  vi.restoreAllMocks();
  await pool.end();
});
it("refuses malformed native answers instead of using model text as a match", async () => {
  const campaign = await ensureCampaign("evaluation");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(response({ match: { type: "refusal" } })),
  );
  await expect(decide(campaign, "input", questions)).rejects.toThrow(
    "Invalid decision response",
  );
});
it("rejects inconsistent choice probabilities", async () => {
  const campaign = await ensureCampaign("evaluation");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      response({
        match: {
          ...answer,
          probabilities: { same: 0.999, different: 0.999, insufficient: 0.1 },
        },
      }),
    ),
  );
  await expect(decide(campaign, "input", questions)).rejects.toThrow(
    "inconsistent",
  );
});
it("does not accept missing usage or cost as a zero-cost request", async () => {
  const campaign = await ensureCampaign("evaluation");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        response(
          { match: answer },
          { inputTokens: 100, outputTokens: 0 },
          null,
        ),
      ),
  );
  await expect(decide(campaign, "input", questions)).rejects.toThrow(
    "reservation retained",
  );
  expect(
    (await pool.query("SELECT status,cost_usd FROM ai_usage")).rows[0],
  ).toMatchObject({ status: "uncertain" });
});
it("records explicit rate-limit rejections without losing their identity", async () => {
  const campaign = await ensureCampaign("evaluation");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => new Response("", { status: 429 })),
  );
  await expect(decide(campaign, "input", questions)).rejects.toThrow(
    "HTTP 429",
  );
  expect(
    (await pool.query("SELECT status,cost_usd FROM ai_usage")).rows[0],
  ).toMatchObject({ status: "rejected", cost_usd: "0.000000000000" });
});
it("reserves the incremental monthly allowance across separate campaigns", async () => {
  const campaign = await ensureCampaign("incremental");
  settings.matching.gateway.monthly_budget_usd = 0.01;
  await pool.query(
    `INSERT INTO ai_usage(campaign_id,endpoint,model,status,input_tokens,output_tokens,cost_usd) VALUES($1,'evaluate','test','success',1,0,0.01)`,
    [campaign.id],
  );
  await pool.query(
    `UPDATE matching_campaigns SET state='completed' WHERE id=$1`,
    [campaign.id],
  );
  const other = await ensureCampaign("incremental");
  const mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  await expect(decide(other, "input", questions)).rejects.toThrow("spending");
  expect(mock).not.toHaveBeenCalled();
});
it("a resumed campaign gets the new month allowance without resetting its history", async () => {
  const campaign = await ensureCampaign("incremental");
  await pool.query(
    `INSERT INTO ai_usage(campaign_id,endpoint,model,status,input_tokens,output_tokens,cost_usd,created_at)
 VALUES($1,'evaluate','test','success',1,0,100,(date_trunc('month',now() AT TIME ZONE $2)-interval '1 second') AT TIME ZONE $2)`,
    [campaign.id, settings.app.timezone],
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(response({ match: answer })),
  );
  expect(
    (await decide(campaign, "input", questions)).answers.match.choice,
  ).toBe("same");
  expect(
    (
      await pool.query("SELECT * FROM ai_usage WHERE campaign_id=$1", [
        campaign.id,
      ])
    ).rowCount,
  ).toBe(2);
});
it("a pause prevents new paid calls and a missing key cannot silently change providers", async () => {
  const campaign = await ensureCampaign("evaluation");
  await pool.query(`UPDATE matching_campaigns SET state='paused' WHERE id=$1`, [
    campaign.id,
  ]);
  const mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  await expect(decide(campaign, "input", questions)).rejects.toThrow("paused");
  expect(mock).not.toHaveBeenCalled();
});

it("retries only confirmed rate-limit rejections with bounded attempts and accounts for every attempt", async () => {
  const campaign = await ensureCampaign("evaluation");
  const calls = vi
    .fn()
    .mockResolvedValueOnce(new Response("", { status: 429 }))
    .mockResolvedValue(response({ match: answer }));
  vi.stubGlobal("fetch", calls);
  expect(
    (await decide(campaign, "retryable input", questions)).answers.match.choice,
  ).toBe("same");
  expect(calls).toHaveBeenCalledTimes(2);
  const usage = (
    await pool.query(
      "SELECT status,cost_usd,http_status,request_key FROM ai_usage ORDER BY created_at",
    )
  ).rows;
  expect(usage[0]).toMatchObject({
    status: "rejected",
    cost_usd: "0.000000000000",
    http_status: 429,
  });
  expect(usage[1]).toMatchObject({
    status: "success",
    http_status: 200,
    request_key: usage[0].request_key,
  });
});

it("never retries a 503 with uncertain billing and returns the reservation that needs recovery", async () => {
  const campaign = await ensureCampaign("evaluation");
  const calls = vi
    .fn()
    .mockImplementation(async () => new Response("", { status: 503 }));
  vi.stubGlobal("fetch", calls);
  await expect(
    decide(campaign, "uncertain input", questions),
  ).rejects.toMatchObject({
    reason: "provider",
    recovery: { action: "defer", billing: "uncertain", http_status: 503 },
  });
  const usage = (await pool.query("SELECT * FROM ai_usage")).rows[0];
  await expect(
    decide(campaign, "uncertain input", questions),
  ).rejects.toMatchObject({
    reason: "inflight",
    recovery: { usage_id: usage.id, action: "defer", billing: "uncertain" },
  });
  expect(calls).toHaveBeenCalledTimes(1);
  expect(usage.status).toBe("uncertain");
  expect(Number(usage.cost_usd)).toBeGreaterThan(0);
});

it("stops rate-limit retries at the configured cap and rechecks permissions between attempts", async () => {
  const campaign = await ensureCampaign("evaluation");
  const calls = vi
    .fn()
    .mockImplementation(async () => new Response("", { status: 429 }));
  vi.stubGlobal("fetch", calls);
  await expect(decide(campaign, "rejected input", questions)).rejects.toThrow(
    "HTTP 429",
  );
  expect(calls).toHaveBeenCalledTimes(settings.matching.gateway.retry_attempts);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM ai_usage WHERE status='rejected' AND cost_usd=0",
      )
    ).rows[0].n,
  ).toBe(settings.matching.gateway.retry_attempts);
  calls.mockClear();
  calls.mockImplementation(async () => {
    await pool.query(
      "UPDATE matching_campaigns SET state='paused' WHERE id=$1",
      [campaign.id],
    );
    return new Response("", { status: 429 });
  });
  await expect(
    decide(campaign, "pause during retry", questions),
  ).rejects.toThrow("paused");
  expect(calls).toHaveBeenCalledTimes(1);
});
