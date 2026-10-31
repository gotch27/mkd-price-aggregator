import { randomUUID } from "node:crypto";
import { beforeEach, afterAll, expect, it, vi } from "vitest";
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
import {
  classificationRequest,
  comparisonRequest,
} from "@/nextsignal/services/ai-gateway";
import {
  readSettings,
  saveSettings,
} from "@/nextsignal/services/task-settings";
import { createTask, executeTask } from "@/nextsignal/services/tasks";
import { taskResults } from "@/nextsignal/services/task-results";
import { comparePairs } from "@/nextsignal/services/identity-decisions";
import type { TaskCommand } from "@/nextsignal/domain/task-settings";
const original = structuredClone(settings.matching);
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  vi.restoreAllMocks();
  Object.assign(settings.matching, structuredClone(original));
  settings.matching.gateway.api_key = "isolated-test-key";
  await pool.query(
    "TRUNCATE retailers,products,runs,sources,operational_settings,operational_settings_history,task_executions,ai_cache,ai_usage CASCADE",
  );
  await seedRetailers();
  const s = await readSettings();
  await saveSettings(
    s.revision,
    { ...s.policy, ai_enabled: true, clarification_enabled: true },
    "tester",
  );
});
afterAll(async () => {
  Object.assign(settings.matching, original);
  vi.unstubAllGlobals();
  await pool.end();
});
async function publish(
  retailer: TaskCommand["retailers"][number],
  names: string[],
  description: string | null = null,
) {
  const source = (
    await pool.query(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,'Identity test',$3,'retailer','{}') RETURNING id",
      [retailer, randomUUID(), settings.sources[retailer].url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", retailer, source, null);
  await stagePage(run, {
    rows: names.map((name, i) => ({
      key: String(i),
      name,
      description,
      category: "ГАЗИРАНИ БЕЗАЛКОХОЛНИ ПИЈАЛОЦИ",
      gtin: null,
      price: "50.00",
      regular_price: null,
      promo_price: null,
      unit_price: null,
      available: true,
      promotion: null,
      source_updated_at: null,
      raw: {},
    })),
    next: null,
    total: names.length,
    artifact: null,
  });
  await publishCatalog(await getRun(run.id));
  const products = (
    await pool.query<{ id: string }>(
      "SELECT id FROM store_products WHERE retailer=$1 ORDER BY name",
      [retailer],
    )
  ).rows;
  await pool.query(
    "INSERT INTO matching_prompt_versions(key,files) VALUES('identity-tests','[]') ON CONFLICT DO NOTHING",
  );
  for (const row of products) {
    const p = await getProduct(row.id);
    await saveClassification(p, {
      key: (await classificationRequest(p)).key,
      family: "soft_drinks",
      hints: [],
      selected: "soft_drinks",
      probabilities: { soft_drinks: 1 },
      model: settings.matching.gateway.decision_model,
      prompt_key: "identity-tests",
      confidence: 0.9,
      generation_id: "fixture",
    });
  }
  return products.map((p) => p.id);
}
function provider(
  route = "brand",
  choice = "same",
  sameProbability = (_body: Record<string, unknown>) => 0.98,
) {
  const calls: { kind: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ kind: body.questions ? "decision" : "clarification", body });
    if (body.questions)
      return Response.json({
        answers: Object.fromEntries(
          Object.entries(body.questions).map(([k, q]) => {
            const criteria = Object.keys(
              (q as { criteria: Record<string, string> }).criteria,
            );
            const selected = k.startsWith("detail_") ? route : choice;
            const probability = k.startsWith("detail_")
              ? 0.98
              : sameProbability(body);
            return [
              k,
              {
                type: "choice",
                choice: selected,
                probabilities: Object.fromEntries(
                  criteria.map((c) => [
                    c,
                    c === selected
                      ? probability
                      : (1 - probability) / (criteria.length - 1),
                  ]),
                ),
                confidence: 0.4,
              },
            ];
          }),
        ),
        usage: { inputTokens: 100, outputTokens: 1 },
        providerMetadata: {
          gateway: { cost: "0.000001", generationId: randomUUID() },
        },
      });
    const input = JSON.parse(body.messages[1].content),
      allowed =
        body.response_format.json_schema.schema.properties.facts.items
          .properties.field.enum;
    expect(allowed).not.toContain("flavour");
    const facts = allowed.includes("brand")
      ? [{ field: "brand", literal: "ХЕБА", quote: "ХЕБА", source: "name" }]
      : [];
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              facts,
              missing: allowed.filter((f: string) => f !== "brand"),
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: "0.000001" },
      providerMetadata: {
        gateway: { cost: "0.000001", generationId: randomUUID() },
      },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}
async function task(anchor: string, extra = 50, recheck_task_id?: string) {
  const saved = await readSettings();
  const t = await createTask(
    {
      revision: saved.revision,
      kind: "match",
      retailers: Object.keys(settings.sources) as TaskCommand["retailers"],
      source_id: null,
      product_limit: 1,
      use_ai: true,
      categories: ["soft_drinks"],
      max_cost_usd: 0.05,
      recheck: !!recheck_task_id,
      recheck_task_id,
      counterpart_limit: extra,
      idempotency_key: randomUUID(),
    },
    "tester",
  );
  if (!recheck_task_id) {
    const p = await getProduct(anchor);
    const { hash } = await import("@/nextsignal/domain/normalize");
    await pool.query(
      "INSERT INTO task_items(task_id,input_id,store_product_id,group_id,input_hash,input_version) VALUES($1,$2,$2,$3,$4,$5)",
      [
        t.id,
        p.id,
        p.group_id,
        hash([p.fingerprint, p.manual_facts]),
        p.version,
      ],
    );
    await pool.query("UPDATE task_executions SET selected=1 WHERE id=$1", [
      t.id,
    ]);
  }
  return t;
}
it("prepares both stores, preserves category keys, saves useful matches and exposes typed results", async () => {
  const [a] = await publish("kam", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]),
    [b] = await publish("spar", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const before = [
    (await classificationRequest(await getProduct(a))).key,
    (await classificationRequest(await getProduct(b))).key,
  ];
  const mocked = provider(),
    t = await task(a);
  await executeTask(t.id);
  expect(mocked.calls[0].kind).toBe("decision");
  const firstState = mocked.calls[0].body.state as {
    products: Record<string, { supported_facts: Record<string, unknown> }>;
  };
  expect(
    Object.values(firstState.products).every((p) => !p.supported_facts.brand),
  ).toBe(true);
  expect((await getProduct(a)).group_id).toBe((await getProduct(b)).group_id);
  expect(mocked.calls.filter((c) => c.kind === "clarification")).toHaveLength(
    2,
  );
  expect([
    (await classificationRequest(await getProduct(a))).key,
    (await classificationRequest(await getProduct(b))).key,
  ]).toEqual(before);
  const result = await taskResults({
    id: t.id,
    page: 1,
    size: 10,
    search: "",
    category: "",
    outcome: "",
  });
  expect(result?.kind).toBe("match");
  if (!result || result.kind !== "match")
    throw new Error("Expected matching results");
  expect(result.rows[0].outcome).toBe("connected");
  expect(result.rows[0].candidates[0]).toMatchObject({
    probability: 0.98,
    confidence: 0.4,
  });
  const count = mocked.calls.length;
  await executeTask(t.id);
  expect(mocked.calls).toHaveLength(count);
  const campaign = (
    await pool.query(
      "SELECT mc.* FROM matching_campaigns mc JOIN task_executions t ON t.campaign_id=mc.id WHERE t.id=$1",
      [t.id],
    )
  ).rows[0];
  await comparePairs(campaign, await getProduct(b), [await getProduct(a)]);
  expect(mocked.calls).toHaveLength(count);
});
it("uses the Decider's missing-from-source route without spending on repeated interpretation", async () => {
  const [a] = await publish("kam", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const [b] = await publish("spar", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const mocked = provider("missing_from_source", "insufficient"),
    t = await task(a);
  await executeTask(t.id);
  expect(mocked.calls.map((c) => c.kind)).toEqual(["decision"]);
  expect((await getProduct(a)).group_id).not.toBe(
    (await getProduct(b)).group_id,
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM matching_task_preparations WHERE task_id=$1",
        [t.id],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("clarifies a useful same answer below 75% and accepts only the reconsidered result", async () => {
  const [a] = await publish("kam", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const [b] = await publish("spar", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const mocked = provider("brand", "same", (body) => {
    const state = body.state as {
      products: Record<string, { supported_facts: Record<string, unknown> }>;
    };
    return Object.values(state.products).every((p) => p.supported_facts.brand)
      ? 0.98
      : 0.65;
  });
  const t = await task(a);
  await executeTask(t.id);
  expect(mocked.calls.map((c) => c.kind)).toEqual([
    "decision",
    "clarification",
    "clarification",
    "decision",
  ]);
  expect((await getProduct(a)).group_id).toBe((await getProduct(b)).group_id);
  const decisions = (
    await pool.query("SELECT answer FROM matching_pair_answers")
  ).rows;
  expect(decisions.map((d) => d.answer.probabilities.same).sort()).toEqual([
    0.65, 0.98,
  ]);
});
it("does not accept a clarified same answer that still stays below 75%", async () => {
  const [a] = await publish("kam", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const [b] = await publish("spar", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const mocked = provider("brand", "same", () => 0.65);
  const t = await task(a);
  await executeTask(t.id);
  expect(mocked.calls.filter((c) => c.kind === "clarification")).toHaveLength(
    2,
  );
  expect((await getProduct(a)).group_id).not.toBe(
    (await getProduct(b)).group_id,
  );
});
it("splits encoded comparisons without truncating source text or repeating cached pairs", async () => {
  const [a] = await publish("kam", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const targets: string[] = [];
  for (const store of ["spar", "vero", "zito", "dim", "zur"] as const)
    targets.push(
      ...(await publish(
        store,
        ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"],
        "Source details ".repeat(100),
      )),
    );
  const query = await getProduct(a);
  const candidates = await Promise.all(
    targets.map(async (id) => {
      const product = await getProduct(id);
      return {
        product,
        members: [product],
        group_version: product.group_version!,
        score: 1,
        reasons: [],
      };
    }),
  );
  const single = Math.max(
    ...candidates.map((c) => comparisonRequest(query, [c]).inputBytes),
  );
  settings.matching.gateway.max_input_bytes = single + 2000;
  expect(comparisonRequest(query, candidates).inputBytes).toBeGreaterThan(
    settings.matching.gateway.max_input_bytes,
  );
  const mocked = provider("missing_from_source", "insufficient");
  const t = await task(a);
  await executeTask(t.id);
  expect(mocked.calls.length).toBeGreaterThan(1);
  for (const call of mocked.calls) {
    expect(Buffer.byteLength(JSON.stringify(call.body))).toBeLessThanOrEqual(
      settings.matching.gateway.max_input_bytes,
    );
    const state = call.body.state as {
      products: Record<string, { description: string }>;
    };
    // The full original text remains in the application-owned identity request.
    expect(JSON.stringify(state)).toContain("Source details ".repeat(99));
  }
  expect(
    (await pool.query("SELECT count(*)::int n FROM matching_pair_answers"))
      .rows[0].n,
  ).toBe(5);
  const count = mocked.calls.length;
  const recheck = await task(a, 50, t.id);
  await executeTask(recheck.id);
  expect(mocked.calls).toHaveLength(count);
});
it.each(["input limit", "budget"])(
  "saves an independent code connection when paid work hits its %s",
  async (failure) => {
    const [a] = await publish("kam", ["Coca-Cola Original 330 ml can"]);
    const [b] = await publish("vero", ["Coca-Cola Original 330 ml can"]);
    await publish(
      "spar",
      ["Cola Original 330 ml can"],
      failure === "input limit" ? "Source details ".repeat(8000) : null,
    );
    const mocked = provider("missing_from_source", "insufficient");
    const t = await task(a);
    if (failure === "budget")
      await pool.query(
        "UPDATE task_executions SET options=jsonb_set(options,'{max_cost_usd}','0') WHERE id=$1",
        [t.id],
      );
    await executeTask(t.id);
    expect((await getProduct(a)).group_id).toBe((await getProduct(b)).group_id);
    expect(mocked.calls).toHaveLength(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM store_match_decisions WHERE outcome='deferred'",
        )
      ).rows[0].n,
    ).toBeGreaterThan(0);
    const results = await taskResults({
      id: t.id,
      page: 1,
      size: 10,
      search: "",
      category: "",
      outcome: "",
    });
    expect(results?.rows[0].outcome).toBe("connected");
    expect(results?.kind === "match" && results.summary.connected).toBe(1);
  },
);
it("reports an individually oversized pair as deferred rather than no candidates", async () => {
  const [a] = await publish("kam", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  await publish(
    "spar",
    ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"],
    "Source details ".repeat(8000),
  );
  const mocked = provider();
  const t = await task(a);
  await executeTask(t.id);
  expect(mocked.calls).toHaveLength(0);
  const results = await taskResults({
    id: t.id,
    page: 1,
    size: 10,
    search: "",
    category: "",
    outcome: "",
  });
  expect(results?.rows[0].outcome).toBe("deferred");
  expect(results?.kind === "match" && results.summary.deferred).toBe(1);
});
it("does not cache a local interpretation size rejection or allocate later counterparts", async () => {
  const [a] = await publish("kam", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const [b] = await publish("spar", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const mocked = provider();
  const implementation = mocked.fetcher.getMockImplementation()!;
  mocked.fetcher.mockImplementationOnce(async (...args) => {
    const response = await implementation(...args);
    settings.matching.gateway.max_input_bytes = 1;
    return response;
  });
  const first = await task(a);
  await executeTask(first.id);
  expect(mocked.calls.map((c) => c.kind)).toEqual(["decision"]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM matching_product_preparations WHERE attempted",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM matching_task_preparations WHERE task_id=$1",
        [first.id],
      )
    ).rows[0].n,
  ).toBe(0);
  settings.matching.gateway.max_input_bytes = original.gateway.max_input_bytes;
  const second = await task(a, 50, first.id);
  await executeTask(second.id);
  expect(mocked.calls.filter((c) => c.kind === "clarification")).toHaveLength(
    2,
  );
  expect((await getProduct(a)).group_id).toBe((await getProduct(b)).group_id);
});
it("persists the counterpart cap and rechecks only the previous unresolved products", async () => {
  const [a] = await publish("kam", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]),
    [b] = await publish("spar", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const mocked = provider(),
    first = await task(a, 0);
  await executeTask(first.id);
  expect((await getProduct(a)).group_id).not.toBe(
    (await getProduct(b)).group_id,
  );
  expect(mocked.calls.filter((c) => c.kind === "clarification")).toHaveLength(
    1,
  );
  const second = await task(a, 1, first.id);
  await executeTask(second.id);
  const ids = (
    await pool.query(
      "SELECT store_product_id FROM task_items WHERE task_id=$1",
      [second.id],
    )
  ).rows;
  expect(ids).toEqual([{ store_product_id: a }]);
  expect((await getProduct(a)).group_id).toBe((await getProduct(b)).group_id);
  expect(mocked.calls.filter((c) => c.kind === "clarification")).toHaveLength(
    2,
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM matching_task_preparations WHERE task_id=$1 AND consumed",
        [second.id],
      )
    ).rows[0].count,
  ).toBe(1);
});
it("joins unambiguous stores while holding two positive candidates from another chain", async () => {
  const [a] = await publish("kam", ["Coca-Cola Original 330 ml can label A"]);
  await publish("spar", [
    "Coca-Cola Original 330 ml can label B",
    "Coca-Cola Original 330 ml can label C",
  ]);
  await publish("vero", ["Coca-Cola Original 330 ml can label D"]);
  await publish("zito", ["Coca-Cola Original 330 ml can label E"]);
  const mocked = provider(),
    t = await task(a);
  await executeTask(t.id);
  const p = await getProduct(a);
  const stores = (
    await pool.query<{ retailer: string }>(
      "SELECT retailer FROM store_products WHERE group_id=$1 ORDER BY retailer",
      [p.group_id],
    )
  ).rows.map((p) => p.retailer);
  expect(stores).toEqual(["kam", "vero", "zito"]);
  expect(mocked.calls.filter((c) => c.kind === "clarification")).toHaveLength(
    0,
  );
  expect(
    (
      await pool.query(
        "SELECT count(DISTINCT group_id)::int count FROM store_products WHERE retailer='spar'",
      )
    ).rows[0].count,
  ).toBe(2);
});
it("counts only fresh counterpart interpretations toward the per-primary cap", async () => {
  const [a] = await publish("kam", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const [complete] = await publish("spar", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  await publish("vero", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  await publish("zito", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  await pool.query(
    `UPDATE store_products SET manual_facts='{"brand":"heba"}',version=version+1 WHERE id=$1`,
    [complete],
  );
  const saved = await readSettings();
  await saveSettings(
    saved.revision,
    { ...saved.policy, counterparts_per_product: 1 },
    "tester",
  );
  const mocked = provider(),
    t = await task(a);
  await executeTask(t.id);
  expect(mocked.calls.filter((c) => c.kind === "clarification")).toHaveLength(
    2,
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM matching_task_preparations WHERE task_id=$1 AND consumed",
        [t.id],
      )
    ).rows[0].count,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM store_products WHERE group_id=$1",
        [(await getProduct(a)).group_id],
      )
    ).rows[0].count,
  ).toBe(3);
  const calls = mocked.calls.length;
  await executeTask(t.id);
  expect(mocked.calls).toHaveLength(calls);
});
it("rejects a recheck that broadens the original catalog or store authorization", async () => {
  const [a] = await publish("kam", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  provider();
  const t = await task(a);
  await executeTask(t.id);
  const s = await readSettings();
  await expect(
    createTask(
      {
        ...t.options,
        revision: s.revision,
        recheck: true,
        recheck_task_id: t.id,
        source_id: randomUUID(),
        idempotency_key: randomUUID(),
      },
      "tester",
    ),
  ).rejects.toThrow();
});

it("remembers unsupported clarification as an abstention instead of paying for it on each recheck", async () => {
  const [a] = await publish("kam", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  await publish("spar", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const mocked = provider();
  const originalProvider = mocked.fetcher.getMockImplementation()!;
  mocked.fetcher.mockImplementation(async (...args) => {
    if (JSON.parse(String(args[1].body)).questions)
      return originalProvider(...args);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              facts: [
                {
                  field: "brand",
                  literal: "Invented",
                  quote: "never supplied",
                  source: "name",
                },
              ],
              missing: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5, cost: "0.000001" },
    });
  });
  const first = await task(a);
  await executeTask(first.id);
  const count = mocked.fetcher.mock.calls.length;
  expect(count).toBe(3);
  const second = await task(a, 50, first.id);
  await executeTask(second.id);
  expect(mocked.fetcher).toHaveBeenCalledTimes(count);
  expect((await getProduct(a)).facts.brand).toBeUndefined();
});
it("stops additional external requests when AI permission is removed after an in-flight interpretation", async () => {
  const [a] = await publish("kam", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  await publish("spar", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const mocked = provider(),
    implementation = mocked.fetcher.getMockImplementation()!;
  mocked.fetcher.mockImplementation(async (...args) => {
    const result = await implementation(...args);
    const saved = await readSettings();
    await saveSettings(
      saved.revision,
      { ...saved.policy, ai_enabled: false },
      "person",
    );
    return result;
  });
  const t = await task(a);
  await executeTask(t.id);
  expect(mocked.fetcher).toHaveBeenCalledTimes(1);
});
it("does not apply interpretation to a product changed while the response was in flight", async () => {
  const [a] = await publish("kam", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const [b] = await publish("spar", ["ВОДА ХЕБА ГАЗИРАНА 1.5Л"]);
  const mocked = provider(),
    implementation = mocked.fetcher.getMockImplementation()!;
  mocked.fetcher.mockImplementation(async (...args) => {
    const result = await implementation(...args);
    await pool.query(
      `UPDATE store_products SET manual_facts='{"brand":"Human correction"}',version=version+1 WHERE id=$1`,
      [a],
    );
    return result;
  });
  const t = await task(a);
  await executeTask(t.id);
  expect(mocked.fetcher).toHaveBeenCalledTimes(1);
  expect((await getProduct(a)).manual_facts?.brand).toBe("Human correction");
  expect((await getProduct(a)).facts.brand?.method).not.toBe("qwen");
  expect((await getProduct(a)).group_id).not.toBe(
    (await getProduct(b)).group_id,
  );
  expect(
    (await pool.query("SELECT state FROM task_items WHERE task_id=$1", [t.id]))
      .rows[0].state,
  ).toBe("deferred");
});
