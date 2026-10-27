import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { app } from "@/nextsignal/app";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import * as database from "@/nextsignal/services/database";
import { services } from "@/nextsignal/services";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import {
  createRun,
  getRun,
  readyForPublication,
} from "@/nextsignal/services/run-repository";
import {
  claimPendingRuns,
  releaseDispatch,
} from "@/nextsignal/services/import-dispatch";
import {
  createTask,
  authorizeRun,
  controlTask,
} from "@/nextsignal/services/tasks";
import {
  readSettings,
  saveSettings,
} from "@/nextsignal/services/task-settings";
import type { CatalogRow } from "@/nextsignal/domain/types";

const originalBuffer = settings.ingestion.max_ready_catalogs;
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  await pool.query(
    "TRUNCATE retailers,sources,runs,products,listings,operational_settings,operational_settings_history,task_executions,host_limits CASCADE",
  );
  await seedRetailers();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected source request");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  settings.ingestion.max_ready_catalogs = originalBuffer;
});
afterAll(() => pool.end());
const row = (price = "50.00"): CatalogRow => ({
  key: "milk",
  name: "Milk 1L",
  description: null,
  category: null,
  gtin: null,
  price,
  regular_price: null,
  promo_price: null,
  unit_price: null,
  available: true,
  promotion: null,
  source_updated_at: null,
  raw: {},
});

async function fixture(count = 5) {
  const saved = await readSettings();
  const owner = await createTask(
    {
      kind: "import",
      retailers: ["kam"],
      source_id: null,
      product_limit: null,
      use_ai: false,
      categories: [],
      max_cost_usd: 0,
      recheck: false,
      idempotency_key: randomUUID(),
      revision: saved.revision,
    },
    "tester",
  );
  await pool.query(
    "UPDATE task_executions SET state='running',checkpoint='{\"initialized\":true}' WHERE id=$1",
    [owner.id],
  );
  const runs = [];
  for (let n = 0; n < count; n++) {
    const source = (
      await pool.query(
        "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES('kam',$1,$1,$2,'branch','{}') RETURNING id",
        [`branch-${n}`, settings.sources.kam.url],
      )
    ).rows[0];
    const run = await createRun("catalog", "kam", source.id, null);
    await pool.query("UPDATE runs SET task_id=$2 WHERE id=$1", [
      run.id,
      owner.id,
    ]);
    runs.push(await getRun(run.id));
  }
  return { owner, runs };
}
async function downloaded(id: string) {
  await stagePage(await getRun(id), {
    rows: [row()],
    next: null,
    total: 1,
    artifact: null,
  });
  await readyForPublication(id);
}

it("reserves two downloads from one chain independently of one final save", async () => {
  const { runs } = await fixture();
  const first = await claimPendingRuns(20);
  expect(first).toHaveLength(2);
  expect(
    first.every((r) => r.retailer === "kam" && r.phase === "download"),
  ).toBe(true);
  await downloaded(first[0].id);
  await releaseDispatch(first[0].id, first[0].dispatch_token);
  const more = await claimPendingRuns(20);
  expect(more.map((r) => r.phase).sort()).toEqual(["download", "publish"]);
  const active = (
    await pool.query(
      "SELECT dispatch_phase,count(*)::int n FROM runs WHERE dispatch_token IS NOT NULL GROUP BY dispatch_phase",
    )
  ).rows;
  expect(
    Object.fromEntries(active.map((r) => [r.dispatch_phase, r.n])),
  ).toEqual({ download: 2, publish: 1 });
  expect(new Set([...first.slice(1), ...more].map((r) => r.id)).size).toBe(3);
  expect(runs).toHaveLength(5);
  expect(fetch).not.toHaveBeenCalled();
});

it("persists a complete download without exposing prices until its separate save turn", async () => {
  const { runs } = await fixture(1);
  const retrieval = vi
    .spyOn(services.importers, "retrieve")
    .mockImplementation(async function* () {
      yield { rows: [row()], next: null, total: 1, artifact: null };
    });
  const d = (await claimPendingRuns(1))[0];
  await authorizeRun(
    d.id,
    () => app.dispatch("catalog.execute", { run_id: d.id }),
    d.dispatch_token,
    "download",
  );
  expect(await getRun(d.id)).toMatchObject({
    status: "pending",
    checkpoint: { done: true },
  });
  expect(
    (
      await pool.query("SELECT * FROM offers WHERE source_id=$1", [
        runs[0].source_id,
      ])
    ).rowCount,
  ).toBe(0);
  const p = (await claimPendingRuns(1))[0];
  expect(p.phase).toBe("publish");
  await authorizeRun(
    p.id,
    () => app.dispatch("catalog.execute", { run_id: p.id }),
    p.dispatch_token,
    "publish",
  );
  expect((await getRun(p.id)).status).toBe("success");
  expect(
    (
      await pool.query("SELECT * FROM offers WHERE source_id=$1", [
        runs[0].source_id,
      ])
    ).rowCount,
  ).toBe(1);
  expect(retrieval).toHaveBeenCalledTimes(1);
});

it("does not steal a completed download before its old reservation is released, and recovers an interrupted handoff", async () => {
  const { runs } = await fixture(1);
  const d = (await claimPendingRuns(1))[0];
  await downloaded(d.id);
  expect(await claimPendingRuns(1)).toEqual([]);
  await pool.query(
    "UPDATE runs SET dispatch_until=now()-interval '1 second' WHERE id=$1",
    [d.id],
  );
  const p = (await claimPendingRuns(1))[0];
  expect(p.id).toBe(runs[0].id);
  expect(p.phase).toBe("publish");
  expect((await getRun(p.id)).retry_failures).toBe(0);
});

it("actually downloads two same-store catalogs concurrently and saves neither prematurely", async () => {
  await fixture(2);
  const claimed = await claimPendingRuns(2);
  let started = 0;
  let signal!: () => void;
  const both = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const releases: Array<() => void> = [];
  vi.spyOn(services.importers, "retrieve").mockImplementation(
    async function* () {
      started++;
      if (started === 2) signal();
      await new Promise<void>((resolve) => releases.push(resolve));
      yield { rows: [row()], next: null, total: 1, artifact: null };
    },
  );
  const jobs = Promise.all(
    claimed.map((d) =>
      authorizeRun(
        d.id,
        () => app.dispatch("catalog.execute", { run_id: d.id }),
        d.dispatch_token,
        "download",
      ),
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      both,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Downloads did not overlap")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    for (const release of releases) release();
    await jobs;
  }
  expect(started).toBe(2);
  expect((await pool.query("SELECT * FROM offers")).rowCount).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT * FROM runs WHERE checkpoint->>'done'='true' AND status='pending'",
      )
    ).rowCount,
  ).toBe(2);
});

it("bounds completed downloads waiting for the database without blocking their publication", async () => {
  settings.ingestion.max_ready_catalogs = 2;
  const { runs } = await fixture();
  await downloaded(runs[0].id);
  await downloaded(runs[1].id);
  const claimed = await claimPendingRuns(20);
  expect(claimed).toHaveLength(1);
  expect(claimed[0].phase).toBe("publish");
  expect(await claimPendingRuns(20)).toEqual([]);
  await pool.query("UPDATE runs SET status='success' WHERE id=$1", [
    claimed[0].id,
  ]);
  await releaseDispatch(claimed[0].id, claimed[0].dispatch_token);
  const next = await claimPendingRuns(20);
  expect(next.filter((r) => r.phase === "download")).toHaveLength(1);
  expect(next.filter((r) => r.phase === "publish")).toHaveLength(1);
});

it("applies a lower per-store limit before an already queued download starts", async () => {
  await fixture(2);
  const claimed = await claimPendingRuns(2);
  const saved = await readSettings();
  await saveSettings(
    saved.revision,
    { ...saved.policy, per_store_downloads: 1 },
    "tester",
  );
  const work = vi.fn(async () => true);
  expect(
    await authorizeRun(
      claimed[1].id,
      work,
      claimed[1].dispatch_token,
      "download",
    ),
  ).toBeNull();
  expect(work).not.toHaveBeenCalled();
  expect(
    await authorizeRun(
      claimed[0].id,
      work,
      claimed[0].dispatch_token,
      "download",
    ),
  ).toBe(true);
});

it("does not recover an expired publication lease while its delivery still owns the locks", async () => {
  const { runs } = await fixture(1);
  await downloaded(runs[0].id);
  const publication = (await claimPendingRuns(1))[0];
  const connection = await pool.connect();
  try {
    await connection.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
      `run-delivery:${publication.id}`,
    ]);
    await pool.query(
      "UPDATE runs SET status='running',dispatch_until=now()-interval '1 second' WHERE id=$1",
      [publication.id],
    );
    expect(await claimPendingRuns(1)).toEqual([]);
    expect(
      (
        await pool.query("SELECT dispatch_token FROM runs WHERE id=$1", [
          publication.id,
        ])
      ).rows[0].dispatch_token,
    ).toBe(publication.dispatch_token);
  } finally {
    await connection.query(
      "SELECT pg_advisory_unlock(hashtextextended($1,0))",
      [`run-delivery:${publication.id}`],
    );
    connection.release();
  }
  const retried = (await claimPendingRuns(1))[0];
  expect(retried.phase).toBe("publish");
  expect(retried.dispatch_token).not.toBe(publication.dispatch_token);
  expect((await getRun(publication.id)).retry_failures).toBe(1);
});

it("can publish a downloaded catalog while its store is cooling down", async () => {
  const { runs } = await fixture(2);
  await downloaded(runs[0].id);
  const host = new URL(settings.sources.kam.url).host;
  await pool.query(
    "INSERT INTO host_limits(host,next_at,consecutive_failures,cooldown_until) VALUES($1,now(),3,now()+interval '10 minutes') ON CONFLICT(host) DO UPDATE SET cooldown_until=excluded.cooldown_until",
    [host],
  );
  const claimed = await claimPendingRuns(10);
  expect(claimed.map((r) => [r.id, r.phase])).toEqual([
    [runs[0].id, "publish"],
  ]);
  expect(fetch).not.toHaveBeenCalled();
});

it("never publishes two complete catalogs concurrently, including direct service callers", async () => {
  const { runs } = await fixture(1);
  await downloaded(runs[0].id);
  const c = await pool.connect();
  await c.query("BEGIN");
  try {
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('catalog-publication',0))",
    );
    expect(await publishCatalog(await getRun(runs[0].id))).toMatchObject({
      status: "deferred",
    });
    expect((await pool.query("SELECT * FROM offers")).rowCount).toBe(0);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
  expect(await publishCatalog(await getRun(runs[0].id))).toMatchObject({
    status: "success",
  });
});

it("rejects a valid token delivered to the wrong lane without revoking its real reservation", async () => {
  await fixture(1);
  const d = (await claimPendingRuns(1))[0];
  const work = vi.fn(async () => true);
  expect(
    await authorizeRun(d.id, work, d.dispatch_token, "publish"),
  ).toBeNull();
  expect(work).not.toHaveBeenCalled();
  expect(
    (await pool.query("SELECT dispatch_token FROM runs WHERE id=$1", [d.id]))
      .rows[0].dispatch_token,
  ).toBe(d.dispatch_token);
});

it("only expands a reviewed task after explicitly reviewing current download limits on resume", async () => {
  let saved = await readSettings();
  await saveSettings(
    saved.revision,
    { ...saved.policy, parallel_imports: 1, per_store_downloads: 1 },
    "tester",
  );
  const { owner } = await fixture(3);
  saved = await readSettings();
  saved = await saveSettings(
    saved.revision,
    { ...saved.policy, parallel_imports: 2, per_store_downloads: 2 },
    "tester",
  );
  const initial = await claimPendingRuns(10);
  expect(initial).toHaveLength(1);
  await controlTask(owner.id, "pause", saved.revision, "tester");
  await controlTask(owner.id, "resume", saved.revision, "tester", true);
  expect(await claimPendingRuns(10)).toHaveLength(2);
  const audit = (
    await pool.query(
      "SELECT * FROM task_import_limit_changes WHERE task_id=$1",
      [owner.id],
    )
  ).rows;
  expect(audit).toHaveLength(1);
  expect(audit[0].after_limits).toEqual({
    parallel_imports: 2,
    per_store_downloads: 2,
  });
  expect(
    (
      await pool.query("SELECT options FROM task_executions WHERE id=$1", [
        owner.id,
      ])
    ).rows[0].options.use_ai,
  ).toBe(false);
});

it("reuses product identities and branch assignments on price-only updates and returning offers", async () => {
  const { runs } = await fixture(2);
  await downloaded(runs[0].id);
  await publishCatalog(await getRun(runs[0].id));
  await downloaded(runs[1].id);
  await publishCatalog(await getRun(runs[1].id));
  expect(
    (await pool.query("SELECT count(*)::int n FROM products")).rows[0].n,
  ).toBe(1);
  const original = (
    await pool.query(
      "SELECT id,group_id,fingerprint,version FROM store_products",
    )
  ).rows;
  const listing = (
    await pool.query("SELECT id,updated_at FROM listings WHERE namespace=$1", [
      "branch-0",
    ])
  ).rows[0];
  const update = await createRun("catalog", "kam", runs[0].source_id, null);
  await stagePage(update, {
    rows: [row("65.00")],
    next: null,
    total: 1,
    artifact: null,
  });
  await publishCatalog(await getRun(update.id));
  expect(
    (
      await pool.query("SELECT updated_at FROM listings WHERE id=$1", [
        listing.id,
      ])
    ).rows[0].updated_at,
  ).toEqual(listing.updated_at);
  expect(
    (
      await pool.query(
        "SELECT id,group_id,fingerprint,version FROM store_products",
      )
    ).rows,
  ).toEqual(original);
  expect(
    (
      await pool.query("SELECT price FROM offers WHERE listing_id=$1", [
        listing.id,
      ])
    ).rows[0].price,
  ).toBe("65.00");
  expect(
    (await pool.query("SELECT count(*)::int n FROM products")).rows[0].n,
  ).toBe(1);
  const removal = await createRun("catalog", "kam", runs[0].source_id, null);
  await stagePage(removal, { rows: [], next: null, total: 0, artifact: null });
  await publishCatalog(await getRun(removal.id));
  const confirmation = (
    await pool.query(
      "SELECT id FROM runs WHERE checkpoint->>'confirmation_of'=$1",
      [removal.id],
    )
  ).rows[0];
  await stagePage(await getRun(confirmation.id), {
    rows: [],
    next: null,
    total: 0,
    artifact: null,
  });
  await publishCatalog(await getRun(confirmation.id));
  expect(
    (await pool.query("SELECT * FROM offers WHERE listing_id=$1", [listing.id]))
      .rowCount,
  ).toBe(0);
  const returning = await createRun("catalog", "kam", runs[0].source_id, null);
  await stagePage(returning, {
    rows: [row("67.00")],
    next: null,
    total: 1,
    artifact: null,
  });
  await publishCatalog(await getRun(returning.id));
  expect(
    (
      await pool.query(
        "SELECT id,group_id,fingerprint,version FROM store_products",
      )
    ).rows,
  ).toEqual(original);
  expect(
    (
      await pool.query("SELECT price FROM offers WHERE listing_id=$1", [
        listing.id,
      ])
    ).rows[0].price,
  ).toBe("67.00");
});

it("retains the downloaded catalog and retries a temporary database save failure without fetching again", async () => {
  const { runs } = await fixture(1);
  await downloaded(runs[0].id);
  const p = (await claimPendingRuns(1))[0];
  vi.spyOn(database, "transaction").mockRejectedValueOnce(
    Object.assign(new Error("Deadlock victim"), { code: "40P01" }),
  );
  await authorizeRun(
    p.id,
    () => app.dispatch("catalog.execute", { run_id: p.id }),
    p.dispatch_token,
    "publish",
  );
  expect(await getRun(p.id)).toMatchObject({
    status: "pending",
    retry_failures: 1,
    checkpoint: { done: true },
  });
  await pool.query("UPDATE runs SET next_attempt_at=now() WHERE id=$1", [p.id]);
  const retry = (await claimPendingRuns(1))[0];
  expect(retry.phase).toBe("publish");
  await authorizeRun(
    retry.id,
    () => app.dispatch("catalog.execute", { run_id: retry.id }),
    retry.dispatch_token,
    "publish",
  );
  expect((await getRun(p.id)).status).toBe("success");
  expect(fetch).not.toHaveBeenCalled();
});
