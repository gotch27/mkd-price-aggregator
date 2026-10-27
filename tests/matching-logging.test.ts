import { randomUUID } from "node:crypto";
import { beforeEach, afterAll, it, expect, vi } from "vitest";
import type { LoggerAdapter, LogEntry } from "@gotch/nextsignal";
import testing from "../config/testing.json" with { type: "json" };
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import { logEvent, withLogContext } from "@/nextsignal/adapters/log-context";
import { loggerAdapter, redact } from "@/nextsignal/adapters/logger";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import * as repository from "@/nextsignal/services/matching-repository";
import { matchBatch } from "@/nextsignal/services/matching";
import { decide, clarify } from "@/nextsignal/services/ai-gateway";
import { normalizeName } from "@/nextsignal/domain/normalize";
import { families, type StoreProduct } from "@/nextsignal/domain/matching";
import type { CatalogRow, Retailer } from "@/nextsignal/domain/types";

const original = structuredClone(settings.matching),
  originalLevel = settings.logging.level;
const label = "Coca-Cola Original 6 x 330 ml cans";
const questions = {
  match: {
    type: "choice" as const,
    instructions: "Compare",
    criteria: { same: "Same", different: "Different", insufficient: "Unknown" },
  },
};
const answer = {
  type: "choice",
  choice: "same",
  probabilities: { same: 0.999, different: 0.0005, insufficient: 0.0005 },
  confidence: 0.9,
};
function native() {
  return Response.json({
    answers: { match: answer },
    usage: { inputTokens: 37, outputTokens: 2 },
    providerMetadata: {
      gateway: { cost: "0.000001", generationId: "gen_logging_test" },
    },
  });
}
function enableMockGateway() {
  settings.matching.gateway.enabled = true;
  settings.matching.gateway.api_key = "vck_private_logging_test";
}
async function events(event: string) {
  return (
    await pool.query(
      "SELECT * FROM logs WHERE data->>'event'=$1 ORDER BY created_at,id",
      [event],
    )
  ).rows;
}
function row(key = "cola", name = label): CatalogRow {
  return {
    key,
    name,
    description: null,
    category: null,
    gtin: null,
    price: "50.00",
    regular_price: null,
    promo_price: null,
    unit_price: null,
    available: true,
    promotion: null,
    source_updated_at: null,
    raw: {},
  };
}
async function staged(retailer: Retailer, rows = [row()]) {
  const source = (
    await pool.query(
      `INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,'logging-test','Logging test',$2,'branch','{}') RETURNING id`,
      [retailer, settings.sources[retailer].url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", retailer, source, null);
  await stagePage(run, {
    rows,
    next: null,
    total: rows.length,
    artifact: null,
  });
  return { run, source };
}
async function publish(retailer: Retailer, rows = [row()]) {
  const prepared = await staged(retailer, rows);
  await publishCatalog(await getRun(prepared.run.id));
  return prepared;
}
function recordingLogger() {
  const entries: { level: string; entry: LogEntry }[] = [];
  const logger: LoggerAdapter = {
    info: async (entry) => {
      entries.push({ level: "info", entry });
    },
    warn: async (entry) => {
      entries.push({ level: "warn", entry });
    },
    error: async (entry) => {
      entries.push({ level: "error", entry });
    },
    debug: async (entry) => {
      entries.push({ level: "debug", entry });
    },
  };
  return { entries, logger };
}
beforeEach(async () => {
  if (new URL(settings.database.url).pathname !== `/${testing.database_name}`)
    throw new Error("Dedicated test database required");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.assign(settings.matching, structuredClone(original));
  settings.logging.level = "debug";
  await pool.query(
    "TRUNCATE retailers,products,runs,listings,sources,logs,ai_cache CASCADE",
  );
  await pool.query(
    `UPDATE matching_state SET cursor=NULL,completed=false WHERE key='store-products'`,
  );
  await seedRetailers();
});
afterAll(async () => {
  Object.assign(settings.matching, original);
  settings.logging.level = originalLevel;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await pool.end();
});

it("keeps concurrent run contexts separate and propagates the injected adapter into nested services", async () => {
  const { entries, logger } = recordingLogger();
  await Promise.all(
    ["one", "two"].map((id) =>
      withLogContext(
        {
          logger,
          process: "matching.test",
          correlationId: id,
          data: { run_id: id },
        },
        async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          await withLogContext(
            { data: { store_product_id: `product-${id}` } },
            () =>
              logEvent("debug", "matching.test.trace", "Tracing nested work"),
          );
        },
      ),
    ),
  );
  expect(entries).toHaveLength(2);
  for (const { level, entry } of entries) {
    expect(level).toBe("debug");
    expect(entry.process).toBe("matching.test");
    expect(entry.data).toMatchObject({
      run_id: entry.correlationId,
      store_product_id: `product-${entry.correlationId}`,
      event: "matching.test.trace",
    });
  }
  const defaultLogger = vi.spyOn(loggerAdapter, "info").mockResolvedValue();
  await logEvent(
    "info",
    "matching.test.outside",
    "Outside the previous context",
  );
  expect(defaultLogger.mock.calls[0][0].data).toEqual({
    event: "matching.test.outside",
  });
});
it("persists scoped identifiers through the standard adapter while preserving numeric usage and redacting secrets", async () => {
  const run = await createRun("match", null, null, null),
    correlation = randomUUID();
  await withLogContext(
    {
      process: "matching.test",
      correlationId: correlation,
      data: { run_id: run.id, campaign_id: "campaign" },
    },
    () =>
      logEvent(
        "info",
        "matching.test.persisted",
        "Scoped log saved",
        {
          input_tokens: 37,
          output_tokens: 2,
          api_key: "vck_hidden",
          access_token: "hidden",
          input_token: "hidden",
          authorization: "Bearer hidden",
        },
        new Error("Bearer vck_hidden_failure"),
      ),
  );
  const [saved] = await events("matching.test.persisted");
  expect(saved).toMatchObject({
    level: "info",
    process: "matching.test",
    run_id: run.id,
    correlation_id: correlation,
  });
  expect(saved.data).toMatchObject({
    campaign_id: "campaign",
    input_tokens: 37,
    output_tokens: 2,
    api_key: "[REDACTED]",
    access_token: "[REDACTED]",
    input_token: "[REDACTED]",
    authorization: "[REDACTED]",
  });
  expect(JSON.stringify(saved.error)).not.toContain("vck_hidden");
  expect(
    redact({
      input_tokens: "a credential disguised as a metric",
      total_tokens: 40,
    }),
  ).toEqual({ input_tokens: "[REDACTED]", total_tokens: 40 });
});
it("logs paid request lifecycle and cache reuse with one request ID and no duplicate provider call", async () => {
  enableMockGateway();
  const campaign = await repository.ensureCampaign("evaluation"),
    correlation = randomUUID();
  const fetchMock = vi.fn().mockImplementation(async () => native());
  vi.stubGlobal("fetch", fetchMock);
  await withLogContext(
    { correlationId: correlation, data: { run_id: randomUUID() } },
    async () => {
      await decide(campaign, "private product input", questions);
      await decide(campaign, "private product input", questions);
    },
  );
  const started = await events("gateway.request.started"),
    completed = await events("gateway.request.completed"),
    cached = await events("gateway.request.cache_hit");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(started).toHaveLength(1);
  expect(completed).toHaveLength(1);
  expect(cached).toHaveLength(1);
  expect(completed[0]).toMatchObject({
    level: "debug",
    correlation_id: correlation,
    data: {
      campaign_id: campaign.id,
      input_tokens: 37,
      output_tokens: 2,
      cost_usd: "0.000001",
      generation_id: "gen_logging_test",
    },
  });
  expect(
    new Set([...started, ...completed, ...cached].map((e) => e.data.request_id))
      .size,
  ).toBe(1);
  expect(JSON.stringify([...started, ...completed, ...cached])).not.toMatch(
    /private product input|vck_private_logging_test/,
  );
});
it("keeps successful request milestones out of info logs while retaining accounting and provider errors", async () => {
  settings.logging.level = "info";
  enableMockGateway();
  const campaign = await repository.ensureCampaign("evaluation");
  const request = vi
    .fn()
    .mockImplementationOnce(async () => native())
    .mockRejectedValueOnce(new Error("Transport unavailable"));
  vi.stubGlobal("fetch", request);
  await decide(campaign, "first product", questions);
  expect(await events("gateway.request.started")).toHaveLength(0);
  expect(await events("gateway.request.completed")).toHaveLength(0);
  expect(
    (await pool.query("SELECT * FROM ai_usage WHERE status='success'"))
      .rowCount,
  ).toBe(1);
  await expect(
    decide(campaign, "another product", questions),
  ).rejects.toThrow();
  expect(await events("gateway.request.failed")).toHaveLength(1);
});
it("does not let an injected logger failure change billing state or repeat a paid call", async () => {
  enableMockGateway();
  const campaign = await repository.ensureCampaign("evaluation");
  const fetchMock = vi.fn().mockImplementation(async () => native());
  vi.stubGlobal("fetch", fetchMock);
  const logger: LoggerAdapter = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: (entry) => {
      if (
        ["gateway.request.started", "gateway.request.completed"].includes(
          String(
            typeof entry.data === "object" &&
              entry.data !== null &&
              "event" in entry.data
              ? entry.data.event
              : "",
          ),
        )
      )
        throw new Error("sink failed");
    },
  };
  await withLogContext({ logger }, async () => {
    await decide(campaign, "input", questions);
    await decide(campaign, "input", questions);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect((await pool.query("SELECT status FROM ai_usage")).rows).toEqual([
    { status: "success" },
  ]);
  expect(await events("logging.adapter.failed")).toHaveLength(2);
});
it.each([
  { kind: "rejected", status: 429, level: "warn", retained: false },
  { kind: "uncertain", status: null, level: "error", retained: true },
])(
  "distinguishes $kind billing failures without logging raw provider errors",
  async ({ status, kind, level, retained }) => {
    enableMockGateway();
    const campaign = await repository.ensureCampaign("evaluation");
    vi.stubGlobal(
      "fetch",
      status
        ? vi.fn().mockImplementation(async () => new Response("", { status }))
        : vi
            .fn()
            .mockRejectedValue(new Error("Bearer vck_raw_transport_secret")),
    );
    await expect(
      decide(campaign, "private request", questions),
    ).rejects.toThrow();
    const [failed] = await events("gateway.request.failed");
    expect(failed).toMatchObject({
      level,
      data: {
        campaign_id: campaign.id,
        http_status: status,
        billing_status: kind,
        reservation_retained: retained,
      },
    });
    expect(JSON.stringify(failed)).not.toMatch(
      /private request|vck_raw_transport_secret|vck_private_logging_test/,
    );
    expect(await events("gateway.request.completed")).toHaveLength(0);
  },
);
it("logs spending-limit deferrals before any provider request is sent", async () => {
  enableMockGateway();
  settings.matching.gateway.evaluation_budget_usd = 0;
  const campaign = await repository.ensureCampaign("evaluation"),
    mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  await expect(decide(campaign, "input", questions)).rejects.toThrow(
    "spending",
  );
  const [deferred] = await events("gateway.request.deferred");
  expect(deferred).toMatchObject({
    level: "warn",
    data: { campaign_id: campaign.id, reason: "budget", allowance_usd: 0 },
  });
  expect(await events("gateway.request.started")).toHaveLength(0);
  expect(mock).not.toHaveBeenCalled();
});
it("records malformed decisions and unsupported clarifications as warnings after their billed requests", async () => {
  enableMockGateway();
  const campaign = await repository.ensureCampaign("evaluation");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        answers: { match: { type: "refusal" } },
        usage: { inputTokens: 37, outputTokens: 0 },
        providerMetadata: { gateway: { cost: "0.000001" } },
      }),
    ),
  );
  await expect(decide(campaign, "input", questions)).rejects.toThrow("Invalid");
  expect((await events("gateway.decision.invalid"))[0].level).toBe("warn");
  await publish("kam");
  const product = await repository.getProduct(
    (await pool.query("SELECT id FROM store_products WHERE retailer='kam'"))
      .rows[0].id,
  );

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                facts: [
                  {
                    field: "brand",
                    value: "Invented",
                    quote: label,
                    source: "name",
                  },
                ],
                missing: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20, cost: 0.000001 },
      }),
    ),
  );
  await expect(clarify(campaign, product, ["brand"])).rejects.toThrow(
    "supporting quote",
  );
  expect((await events("gateway.clarification.rejected"))[0]).toMatchObject({
    level: "warn",
    data: {
      campaign_id: campaign.id,
      store_product_id: product.id,
      retailer: "kam",
    },
  });
  expect(await events("gateway.request.completed")).toHaveLength(2);
});
it("logs rejected clarification fields while retaining independently supported facts", async () => {
  enableMockGateway();
  await publish("kam", [row("spread", "КРЕМ НУТЕЛА 400ГР")]);
  const campaign = await repository.ensureCampaign("evaluation");
  const product = (
    await pool.query<StoreProduct>("SELECT * FROM store_products LIMIT 1")
  ).rows[0];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                facts: [
                  {
                    field: "brand",
                    value: "НУТЕЛА",
                    quote: "НУТЕЛА",
                    source: "name",
                  },
                  {
                    field: "model",
                    value: "Invented",
                    quote: "КРЕМ",
                    source: "name",
                  },
                ],
                missing: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20, cost: 0.000001 },
      }),
    ),
  );
  const facts = await clarify(campaign, product, ["brand", "model"]);
  expect(facts.brand?.value).toBe("nutella");
  expect(facts.model).toBeUndefined();
  expect(
    (await events("gateway.clarification.fields_rejected"))[0],
  ).toMatchObject({
    level: "warn",
    data: {
      campaign_id: campaign.id,
      store_product_id: product.id,
      retained_fields: ["brand"],
      rejected_fields: [
        { field: "model", reason: expect.stringContaining("supporting quote") },
      ],
    },
  });
  expect(await events("gateway.clarification.rejected")).toHaveLength(0);
});
it("logs the actual matching threshold and the reason a positive AI answer was not accepted", async () => {
  enableMockGateway();
  settings.matching.threshold = 0.99;
  settings.matching.ai_categories = ["soft_drinks"];
  await publish("kam", [row("cola", "Coca-Cola Original 330 ml can")]);
  await publish("spar", [row("cola", "Coca-Cola Original 330 ml can item")]);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      return Response.json({
        answers: body.questions.family
          ? {
              family: {
                type: "choice",
                choice: "soft_drinks",
                probabilities: Object.fromEntries(
                  families.map((f) => [f, f === "soft_drinks" ? 1 : 0]),
                ),
              },
            }
          : {
              candidate_0: {
                type: "choice",
                choice: "same",
                probabilities: {
                  same: 0.98,
                  different: 0.01,
                  insufficient: 0.01,
                },
              },
            },
        usage: { inputTokens: 50, outputTokens: 1 },
        providerMetadata: { gateway: { cost: "0.000001" } },
      });
    }),
  );
  const run = await createRun("match", null, null, null);
  await matchBatch(run.id, null);
  const checked = (await events("matching.candidates.checked")).filter(
    (e) => e.data.candidates.length,
  );
  expect(checked.length).toBeGreaterThan(0);
  expect(checked[0].data).toMatchObject({
    threshold: 0.99,
    candidates: [
      expect.objectContaining({
        outcome: "needs_info",
        reason: expect.stringContaining("below the required 0.99"),
      }),
    ],
  });
  expect(
    (
      await pool.query(
        "SELECT count(DISTINCT group_id)::int AS n FROM store_products",
      )
    ).rows[0].n,
  ).toBe(2);
});
it("records campaign transitions once and checkpoint progress only after commit", async () => {
  await publish("kam");
  const observed: { completed: boolean; cursor: string | null }[] = [];
  const logger = recordingLogger().logger;
  logger.info = async (entry) => {
    if (
      (entry.data as Record<string, unknown>)?.event ===
      "matching.backfill.checkpoint"
    )
      observed.push(
        (
          await pool.query(
            `SELECT completed,cursor FROM matching_state WHERE key='store-products'`,
          )
        ).rows[0],
      );
  };
  await withLogContext({ logger }, async () => {
    await repository.backfillStoreProducts();
    await repository.backfillStoreProducts();
  });
  expect(observed).toHaveLength(1);
  expect(observed[0].completed).toBe(true);
  expect(observed[0].cursor).not.toBeNull();
  const campaign = await repository.ensureCampaign("initial");
  await repository.ensureCampaign("initial");
  expect(await events("matching.campaign.created")).toHaveLength(1);
  await repository.pauseCampaign(
    campaign.id,
    "Paused: spending or request limit reached",
  );
  await repository.pauseCampaign(
    campaign.id,
    "Paused: spending or request limit reached",
  );
  expect(await events("matching.campaign.paused")).toHaveLength(1);
  await repository.controlCampaign("resume", null);
  expect((await events("matching.campaign.resumed"))[0]).toMatchObject({
    level: "info",
    data: { campaign_id: campaign.id },
  });
});
it("warns when expired work is reclaimed without exposing the claim token", async () => {
  await publish("kam");
  const run = await createRun("match", null, null, null),
    campaign = await repository.campaignForRun(run.id, null);
  const [claimed] = await repository.claimWork(campaign.id);
  await pool.query(
    `UPDATE matching_work SET lease_until=now()-interval '1 second' WHERE id=$1`,
    [claimed.id],
  );
  await repository.claimWork(campaign.id);
  const [recovered] = await events("matching.work.recovered");
  expect(recovered).toMatchObject({
    level: "warn",
    data: { campaign_id: campaign.id, recovered: 1, work_ids: [claimed.id] },
  });
  expect(JSON.stringify(recovered)).not.toContain(claimed.token);
});
it("logs batch summaries and committed group connections using the current run ID", async () => {
  await publish("kam");
  await publish("spar");
  const run = await createRun("match", null, null, null);
  const correlation = randomUUID();
  await withLogContext(
    { process: "catalog.execute", correlationId: correlation },
    () => matchBatch(run.id, null),
  );
  const [batch] = await events("matching.batch.completed"),
    connections = await events("matching.group.connected");
  expect(batch).toMatchObject({
    level: "info",
    run_id: run.id,
    correlation_id: correlation,
    data: { processed: 2, matched: 1 },
  });
  expect(connections).toHaveLength(1);
  expect(connections[0]).toMatchObject({
    level: "debug",
    run_id: run.id,
    correlation_id: correlation,
    data: { product_name: label, reason: "Same product across stores" },
  });
  expect(
    (await pool.query("SELECT DISTINCT group_id FROM store_products")).rowCount,
  ).toBe(1);
});
it("warns on incompatible group proposals while keeping stale answers at debug level", async () => {
  await publish("kam", [row("a"), row("b")]);
  await publish("spar");
  await matchBatch((await createRun("match", null, null, null)).id, null);
  expect((await events("matching.group.rejected")).length).toBeGreaterThan(0);
  expect((await events("matching.group.rejected"))[0].level).toBe("warn");
  await pool.query(
    `UPDATE matching_work SET campaign_id=NULL,state='pending',token=NULL`,
  );
  await repository.controlCampaign("resume", null);
  const run = await createRun("match", null, null, null),
    campaign = await repository.campaignForRun(run.id, null),
    [work] = await repository.claimWork(campaign.id),
    query = await repository.getProduct(work.store_product_id),
    candidates = await repository.findCandidates(query);
  await repository.saveFacts(
    query,
    {
      ...query.facts,
      variant: { value: "zero", quote: label, source: "name", method: "rule" },
    },
    query.family,
    [],
  );
  await repository.recordResult(
    query,
    work,
    candidates.map((candidate) => ({
      candidate,
      outcome: "matched",
      reason: "Old answer",
      method: "decision",
      probability: 1,
      confidence: 1,
    })),
    "stale",
    "Old answer",
  );
  expect((await events("matching.group.stale"))[0].level).toBe("debug");
});
it("reports publication change counts and emits no success event for a rolled-back publication", async () => {
  const first = await publish("kam");
  const [published] = await events("catalog.publication.completed");
  expect(published).toMatchObject({
    level: "info",
    run_id: first.run.id,
    retailer: "kam",
    source_id: first.source,
    data: { published_offers: 1, products_changed: 1, work_queued: 1 },
  });
  const second = await createRun("catalog", "kam", first.source, null);
  await stagePage(second, {
    rows: [row("other")],
    next: null,
    total: 1,
    artifact: null,
  });
  await pool.query(
    `CREATE FUNCTION test_reject_logged_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test publication rollback'; END $$`,
  );
  try {
    await pool.query(
      `CREATE TRIGGER test_reject_logged_publication BEFORE UPDATE ON catalog_browser_state FOR EACH ROW EXECUTE FUNCTION test_reject_logged_publication()`,
    );
    await expect(publishCatalog(await getRun(second.id))).rejects.toThrow(
      "test publication rollback",
    );
    expect(await events("catalog.publication.completed")).toHaveLength(1);
    expect((await pool.query("SELECT * FROM offers")).rowCount).toBe(1);
  } finally {
    await pool.query(
      "DROP TRIGGER IF EXISTS test_reject_logged_publication ON catalog_browser_state",
    );
    await pool.query(
      "DROP FUNCTION IF EXISTS test_reject_logged_publication()",
    );
  }
});

it("keeps product tracing out of info-level logs while retaining batch summaries", async () => {
  settings.logging.level = "info";
  await publish("kam");
  await publish("spar");
  await matchBatch((await createRun("match", null, null, null)).id, null);
  expect(await events("matching.batch.completed")).toHaveLength(1);
  expect(await events("matching.group.connected")).toHaveLength(0);
  expect(
    (await pool.query(`SELECT 1 FROM logs WHERE level='debug'`)).rowCount,
  ).toBe(0);
});
it("logs a monthly allowance resume only after deferred work becomes pending", async () => {
  await publish("kam");
  const run = await createRun("match", null, null, null),
    campaign = await repository.campaignForRun(run.id, null);
  await pool.query(
    `UPDATE matching_work SET state='deferred' WHERE campaign_id=$1`,
    [campaign.id],
  );
  await pool.query(
    `UPDATE matching_campaigns SET state='paused',reason='Paused: spending or request limit reached',paused_at=(date_trunc('month',now() AT TIME ZONE $2)-interval '1 second') AT TIME ZONE $2 WHERE id=$1`,
    [campaign.id, settings.app.timezone],
  );
  const observed: string[] = [];
  const logger = recordingLogger().logger;
  logger.info = async (entry) => {
    if (
      (entry.data as Record<string, unknown>)?.event ===
      "matching.campaign.resumed"
    )
      observed.push(
        (
          await pool.query(
            "SELECT state FROM matching_work WHERE campaign_id=$1",
            [campaign.id],
          )
        ).rows[0].state,
      );
  };
  await withLogContext({ logger }, async () => {
    await repository.resumeMonthlyBudgets();
    await repository.resumeMonthlyBudgets();
  });
  expect(observed).toEqual(["pending"]);
});
