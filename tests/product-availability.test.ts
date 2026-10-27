import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseKam } from "@/nextsignal/services/parsers";
import { pool } from "@/nextsignal/services/database";
import { settings } from "@/nextsignal/config";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import {
  readSettings,
  saveSettings,
} from "@/nextsignal/services/task-settings";
import {
  createTask,
  executeTask,
  automaticTasks,
  categoryCounts,
} from "@/nextsignal/services/tasks";
import { withTaskContext } from "@/nextsignal/services/task-context";
import {
  getProduct,
  findCandidates,
} from "@/nextsignal/services/matching-repository";
import {
  availabilityMap,
  repairSourceAvailability,
  withAvailableProducts,
} from "@/nextsignal/services/product-availability";
import { readDashboard } from "@/nextsignal/services/dashboard-read";
import { detailsForProduct } from "@/nextsignal/services/product-browser";
import {
  refreshProductStatistics,
  readProductStatistics,
} from "@/nextsignal/services/product-statistics";
import { taskResults } from "@/nextsignal/services/task-results";
import { families } from "@/nextsignal/domain/matching";
import { decide } from "@/nextsignal/services/ai-gateway";
import { ensureCampaign } from "@/nextsignal/services/matching-repository";
import * as availabilityService from "@/nextsignal/services/product-availability";
import {
  recordResult,
  type Work,
} from "@/nextsignal/services/matching-repository";
import type { CatalogRow, Retailer } from "@/nextsignal/domain/types";
import type {
  TaskCommand,
  TaskExecution,
  OperationalPolicy,
} from "@/nextsignal/domain/task-settings";

beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated test database required");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await pool.query(
    "TRUNCATE retailers,products,runs,sources,listings,ai_cache,operational_settings,operational_settings_history,task_executions CASCADE",
  );
  await seedRetailers();
  await readSettings();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected provider request");
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.end();
});
const row = (
  key: string,
  available: boolean | null,
  price = "40.00",
): CatalogRow => ({
  key,
  name: `Coca Cola Original ${key} 330 ml can`,
  description: null,
  category: "Drinks",
  gtin: null,
  price,
  regular_price: null,
  promo_price: null,
  unit_price: null,
  available,
  promotion: null,
  source_updated_at: null,
  raw: {},
});
async function policy(changes: Partial<OperationalPolicy>) {
  const s = await readSettings();
  return saveSettings(s.revision, { ...s.policy, ...changes }, "tester");
}
async function task(changes: Partial<TaskCommand> = {}) {
  const s = await readSettings();
  return createTask(
    {
      revision: s.revision,
      kind: "categorize",
      retailers: ["spar"],
      source_id: null,
      product_limit: 50,
      use_ai: true,
      categories: [],
      max_cost_usd: 0.1,
      recheck: false,
      idempotency_key: randomUUID(),
      ...changes,
    },
    "tester",
  );
}
async function publish(
  retailer: Retailer,
  branch: string,
  rows: CatalogRow[],
  owner?: TaskExecution,
) {
  const source = (
    await pool.query(
      `INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,$2,$3,'branch','{}') ON CONFLICT(retailer,external_id) DO UPDATE SET active=true RETURNING id`,
      [retailer, branch, settings.sources[retailer].url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", retailer, source, null);
  const work = async () => {
    await stagePage(run, {
      rows,
      next: null,
      total: rows.length,
      artifact: null,
    });
    await publishCatalog(await getRun(run.id));
  };
  if (owner) await withTaskContext(owner, await readSettings(), work);
  else await work();
  return source as string;
}
function provider(after?: (name: string) => Promise<void>) {
  const mock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (after) await after(body.state.product?.name ?? "");
    return Response.json({
      answers: {
        family: {
          type: "choice",
          choice: "soft_drinks",
          probabilities: Object.fromEntries(
            families.map((f) => [f, f === "soft_drinks" ? 1 : 0]),
          ),
          confidence: 0.9,
        },
      },
      usage: { inputTokens: 100, outputTokens: 0 },
      providerMetadata: {
        gateway: { cost: "0.000002", generationId: randomUUID() },
      },
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
async function product(key: string, retailer = "spar") {
  const id = (
    await pool.query(
      "SELECT id FROM store_products WHERE retailer=$1 AND (external_key=$2 OR external_key=$2||':1')",
      [retailer, key],
    )
  ).rows[0].id;
  return getProduct(id);
}

it("categorizes only products explicitly available, leaving unavailable and unknown work pending", async () => {
  await policy({ ai_enabled: true });
  await publish("spar", "one", [
    row("yes", true),
    row("no", false),
    row("unknown", null),
  ]);
  const mock = provider(),
    owner = await task();
  await executeTask(owner.id);
  await executeTask(owner.id);
  expect(mock).toHaveBeenCalledTimes(1);
  expect(
    (
      await pool.query(
        "SELECT processed,state FROM task_executions WHERE id=$1",
        [owner.id],
      )
    ).rows[0],
  ).toEqual({ processed: 1, state: "completed" });
  expect(
    (
      await pool.query(
        "SELECT category_pending FROM store_products WHERE id=$1",
        [(await product("no")).id],
      )
    ).rows[0].category_pending,
  ).toBe(true);
  expect((await product("unknown")).classification_key).toBeNull();
  expect((await categoryCounts("spar", "")).counts).toEqual([
    { family: "soft_drinks", count: 1 },
  ]);
  expect((await categoryCounts("spar", "")).uncategorized).toBe(0);
});

it("uses any available branch for chain scope and only the selected branch for catalog scope", async () => {
  await policy({ ai_enabled: true });
  const unavailable = await publish("spar", "one", [row("same", false)]);
  const available = await publish("spar", "two", [row("same", true)]);
  expect((await product("same")).availability).toBe("available");
  const mock = provider();
  const blocked = await task({ source_id: unavailable });
  await executeTask(blocked.id);
  expect(mock).not.toHaveBeenCalled();
  expect(
    (
      await pool.query("SELECT processed FROM task_executions WHERE id=$1", [
        blocked.id,
      ])
    ).rows[0].processed,
  ).toBe(0);
  const allowed = await task({ source_id: available });
  await executeTask(allowed.id);
  expect(mock).toHaveBeenCalledTimes(1);
});

it("combines repeated source rows without losing true, false or unknown availability", async () => {
  const a = {
      ...row("base", false),
      name: "One product",
      raw: { identity_base: "base" },
    },
    b = { ...a, key: "base", available: true };
  const source = await publish("spar", "one", [a, b]);
  expect(
    (
      await pool.query(
        "SELECT available FROM store_product_sources WHERE source_id=$1",
        [source],
      )
    ).rows,
  ).toEqual([{ available: true }]);
  await publish("spar", "one", [a, { ...b, available: null }]);
  const id = (
    await pool.query("SELECT id FROM store_products WHERE retailer='spar'")
  ).rows[0].id;
  expect((await availabilityMap([id])).get(id)).toBe("unknown");
  await publish("spar", "one", [a, { ...b, available: false }]);
  expect((await availabilityMap([id])).get(id)).toBe("unavailable");
});

it("queues a first automatic category when an unavailable product returns, without an import rerun or global reset", async () => {
  await policy({ ai_enabled: true, categorization: "automatic" });
  const owner = await task({
    kind: "import",
    use_ai: false,
    product_limit: null,
    max_cost_usd: 0,
  });
  await publish("spar", "one", [row("returning", false)], owner);
  const before = await product("returning");
  await automaticTasks();
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM task_executions WHERE origin='automatic'",
      )
    ).rows[0].n,
  ).toBe(0);
  await publish("spar", "one", [row("returning", true)], owner);
  expect((await product("returning")).id).toBe(before.id);
  await automaticTasks();
  const next = (
    await pool.query<TaskExecution>(
      "SELECT * FROM task_executions WHERE origin='automatic' AND kind='categorize'",
    )
  ).rows[0];
  expect(next).toBeDefined();
  const mock = provider();
  await executeTask(next.id);
  expect(mock).toHaveBeenCalledTimes(1);
  expect((await product("returning")).classified_family).toBe("soft_drinks");
});

it("categorizes a genuinely new available import automatically when permission was enabled before importing", async () => {
  await policy({ ai_enabled: true, categorization: "automatic" });
  const owner = await task({
    kind: "import",
    use_ai: false,
    product_limit: null,
    max_cost_usd: 0,
  });
  await publish("spar", "one", [row("new", true)], owner);
  await automaticTasks();
  const next = (
    await pool.query<TaskExecution>(
      "SELECT * FROM task_executions WHERE origin='automatic' AND kind='categorize'",
    )
  ).rows[0];
  const mock = provider();
  await executeTask(next.id);
  expect(mock).toHaveBeenCalledTimes(1);
});

it("does not sweep old products merely because automatic categorization is enabled", async () => {
  await policy({ ai_enabled: true });
  const owner = await task({
    kind: "import",
    use_ai: false,
    product_limit: null,
    max_cost_usd: 0,
  });
  await publish("spar", "one", [row("old", true)], owner);
  await policy({ categorization: "automatic" });
  await automaticTasks();
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM task_executions WHERE origin='automatic'",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps and reuses a saved category through unavailable and returning imports without new paid requests", async () => {
  await policy({ ai_enabled: true });
  await publish("spar", "one", [row("memory", true)]);
  const mock = provider(),
    first = await task();
  await executeTask(first.id);
  const before = await product("memory");
  await publish("spar", "one", [row("memory", false)]);
  const blocked = await task({ recheck: true });
  await executeTask(blocked.id);
  expect(mock).toHaveBeenCalledTimes(1);
  expect((await product("memory")).classified_family).toBe("soft_drinks");
  await publish("spar", "one", [row("memory", true)]);
  const again = await task({ recheck: true });
  await executeTask(again.id);
  expect(mock).toHaveBeenCalledTimes(1);
  expect((await product("memory")).group_id).toBe(before.group_id);
});

it("skips a selected product that becomes unavailable while the preceding product is being categorized", async () => {
  await policy({ ai_enabled: true });
  await publish("spar", "one", [row("first", true), row("second", true)]);
  const mock = provider(async (name) => {
    await pool.query(
      "UPDATE store_product_sources ss SET available=false FROM store_products sp WHERE sp.id=ss.store_product_id AND sp.name<>$1",
      [name],
    );
  });
  const owner = await task();
  await executeTask(owner.id);
  expect(mock).toHaveBeenCalledTimes(1);
  const result = await taskResults({
    id: owner.id,
    page: 1,
    size: 30,
    search: "",
    category: "",
    outcome: "skipped",
  });
  expect(result?.total).toBe(1);
  expect(result?.summary.skipped).toBe(1);
  expect(result?.rows[0].reason).toContain("unavailable");
});

it("excludes unavailable and unknown candidate products from matching retrieval", async () => {
  const same = { ...row("same", true), name: "Coca Cola Original 330 ml can" };
  await publish("kam", "one", [same]);
  await publish("spar", "one", [{ ...same, available: false }]);
  await publish("vero", "one", [{ ...same, available: null }]);
  await publish("ramstore", "one", [same]);
  const candidates = await findCandidates(await product("same", "kam"));
  expect(candidates.map((c) => c.product.retailer)).toEqual(["ramstore"]);
  expect(fetch).not.toHaveBeenCalled();
});

it("exposes availability filters and product detail badges while ignoring unavailable low prices", async () => {
  await publish("spar", "one", [
    row("same", false, "1.00"),
    row("out", false),
    row("unknown", null),
  ]);
  await publish("spar", "two", [row("same", true, "40.00")]);
  const query = {
    view: "products" as const,
    retailer: "spar",
    page: 1,
    size: 30,
    search: "",
    name_quality: "all" as const,
  };
  const available = await readDashboard(query);
  expect("total" in available && available.total).toBe(1);
  expect("rows" in available && available.rows[0]).toMatchObject({
    availability: "available",
    price: "40.00",
  });
  const out = await readDashboard({ ...query, availability: "unavailable" });
  expect("total" in out && out.total).toBe(1);
  const unknown = await readDashboard({ ...query, availability: "unknown" });
  expect("total" in unknown && unknown.total).toBe(1);
  const all = await readDashboard({ ...query, availability: "all" });
  expect("total" in all && all.total).toBe(3);
  const detail = await detailsForProduct((await product("out")).group_id);
  expect(detail?.listings[0].availability).toBe("unavailable");
  await refreshProductStatistics(true);
  expect((await readProductStatistics()).availability_counts).toEqual({
    spar: { available: 1, unavailable: 1, unknown: 1 },
  });
});

it("repairs saved availability resumably without granting automatic work or changing matching memory", async () => {
  const source = await publish("spar", "one", [
    row("yes", true),
    row("no", false),
  ]);
  const before = await product("yes");
  await pool.query(
    "UPDATE store_product_sources SET available=NULL WHERE source_id=$1",
    [source],
  );
  await pool.query(
    "UPDATE sources SET availability_indexed_at=NULL WHERE id=$1",
    [source],
  );
  expect((await product("yes")).availability).toBe("unknown");
  expect(await repairSourceAvailability(source)).toMatchObject({ products: 2 });
  expect(await repairSourceAvailability(source)).toBeNull();
  expect((await product("yes")).group_id).toBe(before.group_id);
  expect((await product("yes")).availability).toBe("available");
  expect((await product("no")).availability).toBe("unavailable");
  expect(
    (
      await pool.query("SELECT auto_category_epoch FROM matching_work")
    ).rows.every((r) => r.auto_category_epoch === null),
  ).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it("holds an unindexed catalog even when its old compact availability was true", async () => {
  await policy({ ai_enabled: true });
  const source = await publish("spar", "one", [row("unindexed", true)]);
  await pool.query(
    "UPDATE sources SET availability_indexed_at=NULL WHERE id=$1",
    [source],
  );
  expect((await product("unindexed")).availability).toBe("unknown");
  const owner = await task();
  await executeTask(owner.id);
  expect(fetch).not.toHaveBeenCalled();
});

it("corrects only a missing KAM availability flag using its saved PDF evidence", async () => {
  const fixture = JSON.parse(
    await readFile("tests/fixtures/live/kam.json", "utf8"),
  );
  const parsed = parseKam(fixture.pdf_excerpt)[0];
  expect(parsed.available).toBe(true);
  const source = await publish("kam", "pdf", [{ ...parsed, available: null }]);
  const before = (
    await pool.query(
      "SELECT sp.id,sp.group_id,l.name,o.price FROM store_product_aliases a JOIN store_products sp ON sp.id=a.store_product_id JOIN listings l ON l.id=a.listing_id JOIN offers o ON o.listing_id=l.id AND o.source_id=a.source_id WHERE a.source_id=$1",
      [source],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO artifacts(source_id,run_id,content) SELECT id,published_run,$2 FROM sources WHERE id=$1`,
    [source, fixture.pdf_excerpt],
  );
  await pool.query(
    "UPDATE sources SET availability_indexed_at=NULL WHERE id=$1",
    [source],
  );
  expect(await repairSourceAvailability(source)).toMatchObject({
    source_rows_corrected: 1,
  });
  const after = (
    await pool.query(
      "SELECT sp.id,sp.group_id,l.name,o.price,o.available FROM store_product_aliases a JOIN store_products sp ON sp.id=a.store_product_id JOIN listings l ON l.id=a.listing_id JOIN offers o ON o.listing_id=l.id AND o.source_id=a.source_id WHERE a.source_id=$1",
      [source],
    )
  ).rows[0];
  expect(after).toEqual({ ...before, available: true });
  expect(fetch).not.toHaveBeenCalled();
});

it("blocks a paid request if availability disappears after a work guard was established", async () => {
  await publish("spar", "one", [row("guard", true)]);
  const p = await product("guard");
  const campaign = await ensureCampaign("evaluation");
  await pool.query(
    "UPDATE store_product_sources SET available=false WHERE store_product_id=$1",
    [p.id],
  );
  await expect(
    withAvailableProducts([p.id], p.id, () =>
      decide(campaign, "not sent", {
        same: {
          type: "choice",
          instructions: "Test",
          criteria: { yes: "Yes" },
        },
      }),
    ),
  ).rejects.toThrow("unavailable");
  expect(fetch).not.toHaveBeenCalled();
  expect(
    (await pool.query("SELECT count(*)::int n FROM ai_usage")).rows[0].n,
  ).toBe(0);
});

it("releases an unsent budget reservation if availability changes before the external request", async () => {
  await publish("spar", "one", [row("guard", true)]);
  const p = await product("guard");
  const campaign = await ensureCampaign("evaluation");
  const original = availabilityService.assertAvailableContext;
  let checks = 0;
  vi.spyOn(availabilityService, "assertAvailableContext").mockImplementation(
    async () => {
      if (++checks === 2)
        await pool.query(
          "UPDATE store_product_sources SET available=false WHERE store_product_id=$1",
          [p.id],
        );
      return original();
    },
  );
  const enabled = settings.matching.gateway.enabled;
  settings.matching.gateway.enabled = true;
  try {
    await expect(
      withAvailableProducts([p.id], p.id, () =>
        decide(campaign, "not sent after reservation", {
          same: {
            type: "choice",
            instructions: "Test",
            criteria: { yes: "Yes" },
          },
        }),
      ),
    ).rejects.toThrow("unavailable");
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (await pool.query("SELECT status,cost_usd FROM ai_usage")).rows,
    ).toEqual([{ status: "rejected", cost_usd: "0.000000000000" }]);
  } finally {
    settings.matching.gateway.enabled = enabled;
  }
});

it("refuses a previously proposed connection when its counterpart becomes unavailable before commit", async () => {
  const same = { ...row("same", true), name: "Coca Cola Original 330 ml can" };
  await publish("kam", "one", [same]);
  await publish("spar", "one", [same]);
  const query = await product("same", "kam"),
    candidate = (await findCandidates(query))[0];
  const campaign = await ensureCampaign("evaluation");
  const work = (
    await pool.query<Work>(
      `UPDATE matching_work SET campaign_id=$2,state='running',token=$3 WHERE store_product_id=$1 RETURNING *`,
      [query.id, campaign.id, randomUUID()],
    )
  ).rows[0];
  await pool.query(
    "UPDATE store_product_sources SET available=false WHERE store_product_id=$1",
    [candidate.product.id],
  );
  await expect(
    recordResult(
      query,
      work,
      [
        {
          candidate,
          outcome: "matched",
          reason: "Exact match",
          method: "rules",
          probability: null,
          confidence: null,
        },
      ],
      "availability-race",
      "No connection",
    ),
  ).rejects.toThrow("unavailable");
  expect((await product("same", "kam")).group_id).toBe(query.group_id);
  expect((await product("same")).group_id).toBe(candidate.product.group_id);
  expect(
    (await pool.query("SELECT count(*)::int n FROM store_match_decisions"))
      .rows[0].n,
  ).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
