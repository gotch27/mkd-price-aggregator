import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
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
import { readQueue } from "@/nextsignal/services/category-review";
import {
  readCategory,
  saveCategory,
} from "@/nextsignal/services/product-categories";
import {
  startSession,
  readContext,
  readSession,
  readBatch,
  submitBatch,
  stopSession,
  undoBatch,
  acknowledgeSession,
} from "@/nextsignal/services/agent-category-review";
import type {
  AgentReviewBatch,
  AgentReviewDecision,
} from "@/nextsignal/domain/agent-category-review";
import { withLogContext } from "@/nextsignal/adapters/log-context";

const actor = "test-reviewer";
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  await pool.query(
    "TRUNCATE agent_category_sessions,retailers,products,runs,sources,listings,ai_cache,ai_usage,operational_settings,operational_settings_history,task_executions CASCADE",
  );
  await seedRetailers();
  await readSettings();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Agent review must not call providers");
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.query("TRUNCATE agent_category_sessions CASCADE");
  await pool.end();
});
async function seed(count = 3) {
  const source = (
    await pool.query(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES('spar','agent-test','Test',$1,'branch','{}') RETURNING id",
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
    "INSERT INTO matching_prompt_versions(key,files) VALUES('agent-review-test','[]') ON CONFLICT DO NOTHING",
  );
  const ids = (
    await pool.query("SELECT id FROM store_products ORDER BY name,id")
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
      prompt_key: "agent-review-test",
      confidence: 0.99,
      generation_id: "mock",
    });
  }
  return ids;
}
function start(limit = 50, include_previously_skipped?: boolean) {
  return startSession(
    {
      request_id: randomUUID(),
      limit,
      search: "",
      agent_name: "Codex",
      agent_model: "self-reported-test-model",
      ...(include_previously_skipped === undefined
        ? {}
        : { include_previously_skipped }),
    },
    actor,
  );
}
const decision = (
  p: AgentReviewBatch["products"][number],
  category = "other_food",
): AgentReviewDecision => ({
  member_id: p.id,
  snapshot: p.classification.snapshot,
  action: "set",
  category,
  reason: "The supplied name identifies chocolate.",
});
const skip = (
  p: AgentReviewBatch["products"][number],
): AgentReviewDecision => ({
  ...decision(p),
  action: "skip",
  category: null,
  reason: "Source information remains unclear.",
});
async function skipBatch(session_id: string, account = actor) {
  const batch = await readBatch(session_id, account);
  return submitBatch(
    {
      id: session_id,
      request_id: randomUUID(),
      decisions: batch.products.map(skip),
    },
    account,
  );
}
async function human(id: string, category = "other_food") {
  const p = await getProduct(id),
    view = (await readCategory(p.group_id, id))!;
  return saveCategory(
    {
      id: p.group_id,
      member_id: id,
      snapshot: view.classification.snapshot,
      action: "set",
      category,
      note: "Checked by a person",
    },
    "person",
  );
}

it("does nothing on reads, exposes instructions and all labels, and works with AI off", async () => {
  await seed();
  const context = await readContext(actor);
  expect(context.session).toBeNull();
  expect(context.limits).toMatchObject({
    default_products: 50,
    default_include_previously_skipped: false,
    batch_size: 20,
    max_products: 500,
  });
  expect(context.categories).toHaveLength(16);
  expect(context.instructions).toContain("Do not search the web");
  expect((await readSettings()).policy.ai_enabled).toBe(false);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM agent_category_sessions",
      )
    ).rows[0].count,
  ).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it("excludes earlier skips before applying the session limit, including historical sessions", async () => {
  const ids = await seed(5);
  const first = await start(2);
  await skipBatch(first.id);
  // Existing sessions are marked as having included skips by migration 042.
  // Their already-persisted review items are sufficient; no product backfill.
  await pool.query(
    "UPDATE agent_category_sessions SET include_previously_skipped=true WHERE id=$1",
    [first.id],
  );
  await acknowledgeSession(first.id, actor);
  const next = await start(3);
  expect(next).toMatchObject({ total: 3, include_previously_skipped: false });
  expect((await readBatch(next.id, actor)).products.map((p) => p.id)).toEqual(
    ids.slice(2),
  );
  expect((await readSession(first.id, actor)).skipped).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
});
it("completes empty when only skipped products remain and keeps them in human review", async () => {
  await seed(2);
  const first = await start();
  await skipBatch(first.id);
  await pool.query(
    "UPDATE store_product_sources SET price=price+1,retrieved_at=now()",
  );
  // Group/version metadata is not new categorization evidence.
  await pool.query("UPDATE store_products SET version=version+1");
  const next = await start();
  expect(next).toMatchObject({ state: "completed", total: 0 });
  expect((await readBatch(next.id, actor)).products).toEqual([]);
  const queue = await readQueue({
    status: "needs_review",
    search: "",
    availability: "available",
    page: 1,
    size: 10,
  });
  expect(queue.total).toBe(2);
  expect(queue.rows.every((p) => p.classification.state === "uncertain")).toBe(
    true,
  );
  expect(fetch).not.toHaveBeenCalled();
});
it("allows explicitly requested retries and persists and logs their selection policy", async () => {
  await seed(2);
  const first = await start();
  await skipBatch(first.id);
  const info = vi.fn(),
    debug = vi.fn(),
    warn = vi.fn(),
    error = vi.fn();
  const retry = await withLogContext(
    { logger: { info, debug, warn, error } },
    () => start(2, true),
  );
  expect(retry).toMatchObject({ total: 2, include_previously_skipped: true });
  expect((await readSession(retry.id, actor)).include_previously_skipped).toBe(
    true,
  );
  expect(info.mock.calls[0][0]).toMatchObject({
    data: {
      event: "products.agent_review.started",
      include_previously_skipped: true,
      total: 2,
    },
  });
  const batch = await readBatch(retry.id, actor);
  await submitBatch(
    {
      id: retry.id,
      request_id: randomUUID(),
      decisions: batch.products.map((p) => decision(p)),
    },
    actor,
  );
  expect((await readSession(retry.id, actor)).saved).toBe(2);
});
it("shares skip history across accounts and does not recycle skips when a stopped session is replaced", async () => {
  const ids = await seed(3);
  const first = await start();
  const batch = await readBatch(first.id, actor);
  await submitBatch(
    {
      id: first.id,
      request_id: randomUUID(),
      decisions: [skip(batch.products[0])],
    },
    actor,
  );
  await stopSession(first.id, actor);
  const next = await startSession(
    {
      request_id: randomUUID(),
      limit: 3,
      search: "",
      agent_name: "Other agent",
      agent_model: "",
    },
    "another-account",
  );
  expect(
    (await readBatch(next.id, "another-account")).products.map((p) => p.id),
  ).toEqual(ids.slice(1));
});
it("reconsiders skipped products after useful source changes and a new classification", async () => {
  const [id] = await seed(1);
  const first = await start();
  await skipBatch(first.id);
  await pool.query(
    "UPDATE store_products SET description='Milk chocolate with hazelnuts',version=version+1 WHERE id=$1",
    [id],
  );
  const p = await getProduct(id);
  await saveClassification(p, {
    key: (await classificationRequest(p)).key,
    family: "unknown",
    hints: [],
    selected: "other_food",
    probabilities: { other_food: 0.75, personal_care: 0.25 },
    model: "mock-decider",
    prompt_key: "agent-review-test",
    confidence: 0.99,
    generation_id: "changed-source",
  });
  const next = await start();
  expect(next.total).toBe(1);
  expect((await readBatch(next.id, actor)).products[0].id).toBe(id);
});
it("does not treat rejected stale submissions as confirmed skips", async () => {
  await seed(1);
  const first = await start(),
    batch = await readBatch(first.id, actor);
  await pool.query("UPDATE store_products SET version=version+1");
  const result = await submitBatch(
    {
      id: first.id,
      request_id: randomUUID(),
      decisions: [skip(batch.products[0])],
    },
    actor,
  );
  expect(result.results[0].state).toBe("rejected");
  expect((await start()).total).toBe(1);
});
it("freezes 50 products, reads 20 at a time, and never expands the session", async () => {
  await seed(53);
  const session = await start();
  expect(session.total).toBe(50);
  let total = 0;
  while ((await readSession(session.id, actor)).state === "active") {
    const batch = await readBatch(session.id, actor);
    expect(batch.products.length).toBeLessThanOrEqual(20);
    const result = await submitBatch(
      {
        id: session.id,
        request_id: randomUUID(),
        decisions: batch.products.map((p) => ({
          ...decision(p),
          action: "skip",
          category: null,
          reason: "Source information remains unclear.",
        })),
      },
      actor,
    );
    total += result.results.length;
  }
  expect(total).toBe(50);
  expect((await readBatch(session.id, actor)).products).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM store_products WHERE manual_family IS NOT NULL",
      )
    ).rows[0].count,
  ).toBe(0);
  expect(
    (await pool.query("SELECT count(*)::int count FROM task_executions"))
      .rows[0].count,
  ).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it("saves Agent provenance, original probabilities, reason, audit and a separate review filter", async () => {
  await seed(1);
  const session = await start(),
    batch = await readBatch(session.id, actor),
    p = batch.products[0];
  expect(p.readable_name).toContain("Ч");
  expect(batch.store_guidance.spar).toContain("[ = ш");
  const result = await submitBatch(
    { id: session.id, request_id: randomUUID(), decisions: [decision(p)] },
    actor,
  );
  expect(result.session).toMatchObject({
    state: "completed",
    saved: 1,
    processed: 1,
  });
  const saved = (await readCategory(p.product_id, p.id))!;
  expect(saved.classification).toMatchObject({
    state: "agent",
    source: "agent",
    category: "other_food",
    reviewed_by: actor,
    review_reason: decision(p).reason,
    probability: 0.7,
  });
  expect(saved.classification.options[0].probability).toBe(0.7);
  expect(saved.history[0]).toMatchObject({
    source: "agent",
    actor,
    note: decision(p).reason,
  });
  const queue = await readQueue({
    status: "agent",
    search: "",
    availability: "available",
    page: 1,
    size: 10,
  });
  expect(queue.counts).toMatchObject({
    agent: 1,
    reviewed: 0,
    needs_review: 0,
  });
  expect(queue.rows[0].classification.source).toBe("agent");
  expect((await getProduct(p.id)).manual_family).toBe("other_food");
  expect(fetch).not.toHaveBeenCalled();
});
it("preserves agent choices through later imports and classification attempts", async () => {
  const [id] = await seed(1);
  const session = await start(),
    p = (await readBatch(session.id, actor)).products[0];
  await submitBatch(
    { id: session.id, request_id: randomUUID(), decisions: [decision(p)] },
    actor,
  );
  const source = (
    await pool.query("SELECT id FROM sources WHERE external_id='agent-test'")
  ).rows[0].id;
  const run = await createRun("catalog", "spar", source, null);
  await stagePage(run, {
    rows: [
      {
        key: "0",
        name: "0 ^OKOLADO 100G",
        description: null,
        category: null,
        gtin: null,
        price: "45.00",
        regular_price: null,
        promo_price: null,
        unit_price: null,
        available: true,
        promotion: null,
        source_updated_at: null,
        raw: {},
      },
    ],
    next: null,
    total: 1,
    artifact: null,
  });
  await publishCatalog(await getRun(run.id));
  const product = await getProduct(id);
  expect(product.category_review_source).toBe("agent");
  expect(
    await saveClassification(product, {
      key: (await classificationRequest(product)).key,
      family: "cleaning",
      hints: [],
      selected: "cleaning",
      probabilities: { cleaning: 0.95 },
      model: "mock",
      prompt_key: "agent-review-test",
      confidence: 0.99,
      generation_id: "later",
    }),
  ).toBeNull();
  expect((await readCategory(p.product_id, id))?.classification).toMatchObject({
    source: "agent",
    category: "other_food",
  });
});
it("records a human confirmation even when the category value stays the same", async () => {
  const [id] = await seed(1);
  const session = await start(),
    p = (await readBatch(session.id, actor)).products[0];
  await submitBatch(
    { id: session.id, request_id: randomUUID(), decisions: [decision(p)] },
    actor,
  );
  expect(await human(id)).toMatchObject({ ok: true, changed: true });
  expect((await readCategory(p.product_id, id))?.classification).toMatchObject({
    source: "human",
    state: "manual",
    category: "other_food",
  });
  const undone = await undoBatch(session.id, actor);
  expect(undone.results[0].undo_status).toBe("changed");
  expect((await readCategory(p.product_id, id))?.classification.source).toBe(
    "human",
  );
});
it("rejects stale and unavailable products individually while saving other choices", async () => {
  await seed(3);
  const session = await start(),
    batch = await readBatch(session.id, actor);
  await human(batch.products[0].id, "cleaning");
  await pool.query(
    "UPDATE store_product_sources SET available=false WHERE store_product_id=$1",
    [batch.products[1].id],
  );
  const result = await submitBatch(
    {
      id: session.id,
      request_id: randomUUID(),
      decisions: batch.products.map((p) => decision(p)),
    },
    actor,
  );
  expect(result.results.map((r) => r.state)).toEqual([
    "rejected",
    "rejected",
    "saved",
  ]);
  expect(result.session).toMatchObject({ processed: 3, saved: 1, rejected: 2 });
  expect((await getProduct(batch.products[0].id)).manual_family).toBe(
    "cleaning",
  );
});
it("does not select human, already assigned, unavailable, or uncategorized products", async () => {
  const ids = await seed(5);
  await human(ids[0]);
  await pool.query(
    "UPDATE store_product_classifications SET family='other_food' WHERE store_product_id=$1",
    [ids[1]],
  );
  await pool.query(
    "UPDATE store_product_sources SET available=false WHERE store_product_id=$1",
    [ids[2]],
  );
  await pool.query(
    "UPDATE store_products SET classification_key=NULL WHERE id=$1",
    [ids[3]],
  );
  const session = await start();
  expect(session.total).toBe(1);
  expect((await readBatch(session.id, actor)).products[0].id).toBe(ids[4]);
});
it("makes start and submit retries safe and rejects reusing IDs for different data", async () => {
  await seed(1);
  const input = {
    request_id: randomUUID(),
    limit: 50,
    search: "",
    agent_name: "",
    agent_model: "",
  };
  const a = await startSession(input, actor),
    b = await startSession(input, actor);
  expect(b.id).toBe(a.id);
  await expect(startSession({ ...input, limit: 3 }, actor)).rejects.toThrow(
    "different session settings",
  );
  const p = (await readBatch(a.id, actor)).products[0],
    submission = {
      id: a.id,
      request_id: randomUUID(),
      decisions: [decision(p)],
    };
  const first = await submitBatch(submission, actor),
    again = await submitBatch(submission, actor);
  expect(again.batch_id).toBe(first.batch_id);
  expect(
    (await pool.query("SELECT count(*)::int count FROM product_category_edits"))
      .rows[0].count,
  ).toBe(1);
  await expect(
    submitBatch({ ...submission, decisions: [decision(p, "cleaning")] }, actor),
  ).rejects.toThrow("different decisions");
});
it("serializes competing submissions and counts a product only once", async () => {
  await seed(1);
  const session = await start(),
    p = (await readBatch(session.id, actor)).products[0];
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      submitBatch(
        { id: session.id, request_id: randomUUID(), decisions: [decision(p)] },
        actor,
      ),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await readSession(session.id, actor)).processed).toBe(1);
});
it("holds scope, rejects an active replacement, and blocks saves after Stop", async () => {
  await seed(2);
  const session = await start(1),
    p = (await readBatch(session.id, actor)).products[0];
  await expect(start()).rejects.toThrow("already active");
  const foreign = { ...decision(p), member_id: randomUUID() };
  await expect(
    submitBatch(
      { id: session.id, request_id: randomUUID(), decisions: [foreign] },
      actor,
    ),
  ).rejects.toThrow("outside this session");
  await stopSession(session.id, actor);
  expect((await readBatch(session.id, actor)).products).toEqual([]);
  await expect(
    submitBatch(
      { id: session.id, request_id: randomUUID(), decisions: [decision(p)] },
      actor,
    ),
  ).rejects.toThrow("stopped or completed");
  await expect(readSession(session.id, "other-account")).rejects.toThrow(
    "not found",
  );
});
it("undoes a batch safely and keeps newer human choices", async () => {
  await seed(2);
  const session = await start(),
    batch = await readBatch(session.id, actor);
  await submitBatch(
    {
      id: session.id,
      request_id: randomUUID(),
      decisions: batch.products.map((p) => decision(p)),
    },
    actor,
  );
  await human(batch.products[0].id, "cleaning");
  const result = await undoBatch(session.id, actor);
  expect(result.results.map((r) => r.undo_status)).toEqual([
    "changed",
    "restored",
  ]);
  expect((await getProduct(batch.products[1].id)).manual_family).toBeNull();
  expect((await getProduct(batch.products[0].id)).manual_family).toBe(
    "cleaning",
  );
  const count = (
    await pool.query("SELECT count(*)::int count FROM product_category_edits")
  ).rows[0].count;
  await undoBatch(session.id, actor);
  expect(
    (await pool.query("SELECT count(*)::int count FROM product_category_edits"))
      .rows[0].count,
  ).toBe(count);
});
it("enforces session, batch, allowed-label and duplicate limits at the service boundary", async () => {
  await expect(start(501)).rejects.toThrow("limit");
  await seed(1);
  const session = await start(),
    p = (await readBatch(session.id, actor)).products[0];
  for (const decisions of [
    [],
    Array.from({ length: 21 }, () => decision(p)),
    [decision(p), decision(p)],
    [decision(p, "unknown")],
    [{ ...decision(p), reason: "" }],
  ])
    await expect(
      submitBatch(
        { id: session.id, request_id: randomUUID(), decisions },
        actor,
      ),
    ).rejects.toThrow();
  expect((await readSession(session.id, actor)).processed).toBe(0);
});
it("requires authenticated same-origin API calls and rejects forged source and invalid payloads", async () => {
  const { GET, POST } = await import("@/app/api/review/agent-sessions/route");
  const { SESSION_COOKIE, sessionToken } =
    await import("@/nextsignal/adapters/auth");
  const origin = settings.auth.allowed_origins[0],
    url = new URL("/api/review/agent-sessions", origin);
  expect((await GET(new Request(url))).status).toBe(401);
  const headers = {
    cookie: `${SESSION_COOKIE}=${sessionToken()}`,
    origin,
    "content-type": "application/json",
  };
  const body = {
    request_id: randomUUID(),
    limit: 1,
    search: "",
    agent_name: "Codex",
    agent_model: "",
  };
  expect(
    (
      await POST(
        new Request(url, {
          method: "POST",
          headers: { ...headers, origin: "https://foreign.invalid" },
          body: JSON.stringify(body),
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await POST(
        new Request(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, source: "human" }),
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await POST(
        new Request(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, limit: 501 }),
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await POST(
        new Request(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, include_previously_skipped: "true" }),
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await POST(
        new Request(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      )
    ).status,
  ).toBe(200);
});

it("logs a batch summary through the adapter while keeping individual choices in audit history", async () => {
  await seed(2);
  const session = await start(),
    batch = await readBatch(session.id, actor);
  const info = vi.fn(),
    debug = vi.fn(),
    warn = vi.fn(),
    error = vi.fn();
  await withLogContext({ logger: { info, debug, warn, error } }, () =>
    submitBatch(
      {
        id: session.id,
        request_id: randomUUID(),
        decisions: batch.products.map((p) => decision(p)),
      },
      actor,
    ),
  );
  expect(info).toHaveBeenCalledTimes(2);
  expect(info.mock.calls[0][0]).toMatchObject({
    data: { event: "products.agent_review.batch_saved", saved: 2 },
  });
  expect(info.mock.calls[1][0]).toMatchObject({
    data: { event: "products.agent_review.completed", processed: 2 },
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM product_category_edits WHERE source='agent'",
      )
    ).rows[0].count,
  ).toBe(2);
});

it("migrates existing human choices without changing their category or audit attribution", async () => {
  const client = await pool.connect();
  const schema = `agent_migration_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    await client.query(
      "CREATE TABLE store_products(id uuid PRIMARY KEY,manual_family text); CREATE TABLE product_category_edits(id uuid PRIMARY KEY,store_product_id uuid,actor text,note text,created_at timestamptz)",
    );
    const id = randomUUID();
    await client.query("INSERT INTO store_products VALUES($1,'dairy')", [id]);
    await client.query(
      "INSERT INTO product_category_edits VALUES($1,$2,'previous-reviewer','Verified milk','2026-10-01T12:00:00Z')",
      [randomUUID(), id],
    );
    await client.query(
      await readFile("migrations/036_agent_category_review.sql", "utf8"),
    );
    expect(
      (await client.query("SELECT * FROM store_products WHERE id=$1", [id]))
        .rows[0],
    ).toMatchObject({
      id,
      manual_family: "dairy",
      category_review_source: "human",
      category_review_actor: "previous-reviewer",
      category_review_reason: "Verified milk",
    });
    expect(
      (await client.query("SELECT source FROM product_category_edits")).rows[0]
        .source,
    ).toBe("human");
    expect(
      (
        await client.query(
          "SELECT count(*)::int count FROM agent_category_sessions",
        )
      ).rows[0].count,
    ).toBe(0);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

it("migrates the original skip records without changing membership, decisions, or source evidence", async () => {
  const client = await pool.connect();
  const schema = `agent_skip_migration_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE agent_category_sessions(id uuid PRIMARY KEY,state text);
      CREATE TABLE agent_category_items(session_id uuid,store_product_id uuid,state text,review_item jsonb);
    `);
    const session = randomUUID(),
      product = randomUUID();
    const item = {
      name: "Original name",
      classification: { classification_id: randomUUID() },
    };
    await client.query(
      "INSERT INTO agent_category_sessions VALUES($1,'completed')",
      [session],
    );
    await client.query(
      "INSERT INTO agent_category_items VALUES($1,$2,'skipped',$3)",
      [session, product, item],
    );
    await client.query(
      await readFile("migrations/042_agent_review_skips.sql", "utf8"),
    );
    expect(
      (await client.query("SELECT * FROM agent_category_sessions")).rows,
    ).toEqual([
      { id: session, state: "completed", include_previously_skipped: true },
    ]);
    expect(
      (await client.query("SELECT * FROM agent_category_items")).rows,
    ).toEqual([
      {
        session_id: session,
        store_product_id: product,
        state: "skipped",
        review_item: item,
      },
    ]);
    expect(
      (
        await client.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='agent_category_items_skipped_product'",
          [schema],
        )
      ).rows[0].indexdef,
    ).toContain("WHERE (state = 'skipped'::text)");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

it("remembers OK without removing labels, results, audit or undo history and leaves newer reviews visible", async () => {
  await seed(2);
  const session = await start(1),
    product = (await readBatch(session.id, actor)).products[0];
  await submitBatch(
    {
      id: session.id,
      request_id: randomUUID(),
      decisions: [decision(product)],
    },
    actor,
  );
  const before = (
    await pool.query("SELECT count(*)::int count FROM product_category_edits")
  ).rows[0].count;
  const info = vi.fn();
  const logger = { info, warn: vi.fn(), error: vi.fn() };
  const first = await withLogContext({ logger }, () =>
    acknowledgeSession(session.id, actor),
  );
  const again = await withLogContext({ logger }, () =>
    acknowledgeSession(session.id, actor),
  );
  expect(first.acknowledged_at).not.toBeNull();
  expect(again.acknowledged_at).toEqual(first.acknowledged_at);
  expect(first).toMatchObject({ state: "completed", saved: 1, can_undo: true });
  expect(first.results).toHaveLength(1);
  expect((await readContext(actor)).session?.acknowledged_at).toEqual(
    first.acknowledged_at,
  );
  expect((await getProduct(product.id)).manual_family).toBe("other_food");
  expect(
    (await pool.query("SELECT count(*)::int count FROM product_category_edits"))
      .rows[0].count,
  ).toBe(before);
  expect(info).toHaveBeenCalledTimes(1);
  expect(info.mock.calls[0][0]).toMatchObject({
    data: { event: "products.agent_review.acknowledged" },
  });
  const next = await start(1);
  await acknowledgeSession(session.id, actor);
  expect((await readContext(actor)).session).toMatchObject({
    id: next.id,
    state: "active",
    acknowledged_at: null,
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("allows OK only for finished or stopped sessions owned by the account", async () => {
  await seed(1);
  const session = await start(1);
  await expect(acknowledgeSession(session.id, actor)).rejects.toThrow(
    "Finish or stop",
  );
  expect((await readSession(session.id, actor)).acknowledged_at).toBeNull();
  await expect(
    acknowledgeSession(session.id, "another-account"),
  ).rejects.toThrow("not found");
  await stopSession(session.id, actor);
  const stopped = await acknowledgeSession(session.id, actor);
  expect(stopped.state).toBe("stopped");
  expect(stopped.acknowledged_at).not.toBeNull();
  expect(
    (await getProduct(stopped.results[0].member_id)).manual_family,
  ).toBeNull();
});

it("protects the acknowledgment endpoint with authentication and origin checks", async () => {
  const session = await startSession(
    {
      request_id: randomUUID(),
      limit: 1,
      search: "",
      agent_name: "",
      agent_model: "",
    },
    settings.auth.username,
  );
  const { POST } =
    await import("@/app/api/review/agent-sessions/[id]/acknowledge/route");
  const { SESSION_COOKIE, sessionToken } =
    await import("@/nextsignal/adapters/auth");
  const origin = settings.auth.allowed_origins[0],
    url = new URL(
      `/api/review/agent-sessions/${session.id}/acknowledge`,
      origin,
    ),
    context = { params: Promise.resolve({ id: session.id }) };
  expect(
    (await POST(new Request(url, { method: "POST", body: "{}" }), context))
      .status,
  ).toBe(401);
  const headers = {
    cookie: `${SESSION_COOKIE}=${sessionToken()}`,
    origin,
    "content-type": "application/json",
  };
  expect(
    (
      await POST(
        new Request(url, {
          method: "POST",
          headers: { ...headers, origin: "https://foreign.invalid" },
          body: "{}",
        }),
        context,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await POST(
        new Request(url, { method: "POST", headers, body: "{}" }),
        context,
      )
    ).status,
  ).toBe(200);
  expect(
    (await readSession(session.id, settings.auth.username)).acknowledged_at,
  ).not.toBeNull();
});
