import { randomUUID } from "node:crypto";
import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import { sessionToken, SESSION_COOKIE } from "@/nextsignal/adapters/auth";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import {
  getProduct,
  saveClassification,
} from "@/nextsignal/services/matching-repository";
import { classificationRequest } from "@/nextsignal/services/ai-gateway";
import { readSettings } from "@/nextsignal/services/task-settings";
import {
  readCategory,
  saveCategory,
} from "@/nextsignal/services/product-categories";
import { POST as prepare } from "@/app/api/review/agent-sessions/batch/route";
import { GET as context } from "@/app/api/review/agent-sessions/route";
import { GET as batch } from "@/app/api/review/agent-sessions/[id]/batch/route";
import { POST as submit } from "@/app/api/review/agent-sessions/[id]/decisions/route";
import { POST as undo } from "@/app/api/review/agent-sessions/[id]/undo/route";
import { POST as stop } from "@/app/api/review/agent-sessions/[id]/stop/route";
import { POST as acknowledge } from "@/app/api/review/agent-sessions/[id]/acknowledge/route";
import { GET as taskSettings } from "@/app/api/task-settings/route";
import { POST as tasks } from "@/app/api/tasks/route";
import { PATCH as humanCategory } from "@/app/api/products/[id]/category/route";
import type { PreparedAgentReviewBatch } from "@/nextsignal/domain/agent-category-review";

const password = "isolated-agent-review-test-password",
  originalPassword = settings.auth.password;
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  settings.auth.password = password;
  await pool.query(
    "TRUNCATE agent_category_sessions,retailers,products,runs,sources,listings,ai_cache,ai_usage,operational_settings,operational_settings_history,task_executions CASCADE",
  );
  await seedRetailers();
  await readSettings();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Agent review must not call an AI provider");
    }),
  );
});
afterAll(async () => {
  settings.auth.password = originalPassword;
  vi.unstubAllGlobals();
  await pool.query("TRUNCATE agent_category_sessions CASCADE");
  await pool.end();
});
function request(
  method = "GET",
  body?: unknown,
  auth: string | false = `Bearer ${password}`,
  origin?: string,
) {
  return new Request("http://localhost:3000/api/review/agent-sessions", {
    method,
    headers: {
      ...(auth ? { authorization: auth } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(origin ? { origin } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const start = (limit = 3) => ({
  request_id: randomUUID(),
  limit,
  search: "",
  agent_name: "Browserless agent",
  agent_model: "self-reported-test-model",
});
async function prepared(input = start()): Promise<PreparedAgentReviewBatch> {
  const r = await prepare(request("POST", input));
  expect(r.status).toBe(200);
  return (await r.json()).data;
}
const choices = (p: PreparedAgentReviewBatch) => ({
  request_id: randomUUID(),
  decisions: p.batch.products.map((product) => ({
    member_id: product.id,
    snapshot: product.classification.snapshot,
    action: "set",
    category: "other_food",
    reason: "The supplied name identifies chocolate.",
  })),
});
async function seed(count = 3) {
  const source = (
    await pool.query(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES('spar','api-review','Test',$1,'branch','{}') RETURNING id",
      [settings.sources.spar.url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", "spar", source, null);
  await stagePage(run, {
    rows: Array.from({ length: count }, (_, i) => ({
      key: String(i),
      name: `${i} ^OKOLADO 100G`,
      description: null,
      category: null,
      gtin: null,
      price: "40.00",
      regular_price: null,
      promo_price: null,
      unit_price: null,
      available: true,
      promotion: null,
      source_updated_at: null,
      raw: {},
    })),
    next: null,
    total: count,
    artifact: null,
  });
  await publishCatalog(await getRun(run.id));
  await pool.query(
    "INSERT INTO matching_prompt_versions(key,files) VALUES('api-review-test','[]') ON CONFLICT DO NOTHING",
  );
  const ids = (
    await pool.query("SELECT id FROM store_products ORDER BY id")
  ).rows.map((r) => r.id as string);
  for (const id of ids) {
    const p = await getProduct(id);
    await saveClassification(p, {
      key: (await classificationRequest(p)).key,
      family: "unknown",
      hints: [],
      selected: "other_food",
      probabilities: { other_food: 0.7, personal_care: 0.3 },
      model: "mock-decider",
      prompt_key: "api-review-test",
      confidence: 0.99,
      generation_id: "mock",
    });
  }
  return ids;
}

it("authenticates only review routes, with no browser login or extra key", async () => {
  expect((await context(request())).status).toBe(200);
  for (const authorization of [
    false,
    "Bearer wrong-password",
    "Basic credentials",
    "Bearer",
    "Bearer wrong token",
  ] as const)
    expect(
      (await context(request("GET", undefined, authorization))).status,
    ).toBe(401);
  expect((await taskSettings(request())).status).toBe(401);
  expect((await tasks(request("POST", {}))).status).toBe(401);
  expect(
    (await humanCategory(request("PATCH", {}), params(randomUUID()))).status,
  ).toBe(401);
  expect(
    (await acknowledge(request("POST", {}), params(randomUUID()))).status,
  ).toBe(401);
  expect(
    (await pool.query("SELECT count(*)::int n FROM agent_category_sessions"))
      .rows[0].n,
  ).toBe(0);
  const cookieRequest = request("GET", undefined, false);
  cookieRequest.headers.set("cookie", `${SESSION_COOKIE}=${sessionToken()}`);
  expect((await context(cookieRequest)).status).toBe(200);
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects foreign write origins and stops accepting a replaced password", async () => {
  expect(
    (
      await prepare(
        request("POST", start(), undefined, "https://unrelated.example"),
      )
    ).status,
  ).toBe(403);
  settings.auth.password = "replacement-isolated-test-password";
  expect((await context(request())).status).toBe(401);
  expect(
    (
      await context(
        request("GET", undefined, `Bearer ${settings.auth.password}`),
      )
    ).status,
  ).toBe(200);
  expect(
    (await pool.query("SELECT count(*)::int n FROM agent_category_sessions"))
      .rows[0].n,
  ).toBe(0);
});
it("rejects oversized scopes before selecting any products", async () => {
  expect(
    (
      await prepare(
        request("POST", start(settings.agent_review.batch_size + 1)),
      )
    ).status,
  ).toBe(400);
  expect(
    (await pool.query("SELECT count(*)::int n FROM agent_category_sessions"))
      .rows[0].n,
  ).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it("returns readable review data and saves Agent labels idempotently with UI results and undo", async () => {
  await seed();
  const input = start();
  const p = await prepared(input);
  expect(p.session.total).toBe(3);
  expect(p.batch.products).toHaveLength(3);
  expect(p.categories.some((c) => c.id === "other_food")).toBe(true);
  expect(p.instructions.length).toBeGreaterThan(0);
  expect(p.batch.products[0].readable_name).toContain("ЧОКОЛАДО");
  expect(p.batch.products[0].classification.suggested_category).toBe(
    "other_food",
  );
  expect((await prepared(input)).session.id).toBe(p.session.id);
  const decisions = choices(p),
    r = await submit(request("POST", decisions), params(p.session.id));
  expect(r.status).toBe(200);
  const result = (await r.json()).data;
  expect(
    result.results.every((x: { state: string }) => x.state === "saved"),
  ).toBe(true);
  const replay = await submit(request("POST", decisions), params(p.session.id));
  expect(replay.status).toBe(200);
  expect((await replay.json()).data.replayed).toBe(true);
  expect(
    (await pool.query("SELECT count(*)::int n FROM product_category_edits"))
      .rows[0].n,
  ).toBe(3);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM store_products WHERE manual_family='other_food' AND category_review_source='agent'",
      )
    ).rows[0].n,
  ).toBe(3);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM store_product_classifications",
      )
    ).rows[0].n,
  ).toBe(3);
  const finished = await batch(request(), params(p.session.id));
  expect((await finished.json()).data.products).toEqual([]);
  expect((await undo(request("POST", {}), params(p.session.id))).status).toBe(
    200,
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM store_products WHERE manual_family IS NOT NULL",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (await pool.query("SELECT count(*)::int n FROM ai_usage")).rows[0].n,
  ).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  const logs = (await pool.query("SELECT data,error,message FROM logs")).rows;
  expect(JSON.stringify(logs)).not.toContain(password);
});
it("protects newer human choices and rejects changed retries or submissions after stop", async () => {
  await seed(5);
  const p = await prepared();
  const first = p.batch.products[0];
  const view = (await readCategory(first.product_id, first.id))!;
  await saveCategory(
    {
      id: first.product_id,
      member_id: first.id,
      snapshot: view.classification.snapshot,
      action: "set",
      category: "personal_care",
      note: "Newer human choice",
    },
    "person",
  );
  const body = choices(p),
    r = await submit(request("POST", body), params(p.session.id));
  expect(r.status).toBe(200);
  const result = (await r.json()).data;
  expect(
    result.results.filter((x: { state: string }) => x.state === "saved"),
  ).toHaveLength(2);
  expect(result.results[0].state).toBe("rejected");
  expect((await getProduct(first.id)).manual_family).toBe("personal_care");
  const changed = {
    ...body,
    decisions: body.decisions.map((d) => ({ ...d, category: "household" })),
  };
  expect(
    (await submit(request("POST", changed), params(p.session.id))).status,
  ).toBe(400);
  const next = await prepared(start(1));
  expect(
    (await stop(request("POST", {}), params(next.session.id))).status,
  ).toBe(200);
  expect(
    (await submit(request("POST", choices(next)), params(next.session.id)))
      .status,
  ).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
