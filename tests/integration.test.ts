import { beforeAll, beforeEach, afterAll, it, expect, vi } from "vitest";
import { readdir, readFile, writeFile, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import testing from "../config/testing.json" with { type: "json" };
import { settings, configSchema } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import {
  seedRetailers,
  saveDiscovery,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import {
  createRun,
  getRun,
  restartCatalog,
} from "@/nextsignal/services/run-repository";
import {
  enqueueDue,
  nextOccurrence,
  recoverOrphans,
} from "@/nextsignal/services/scheduling";
import { withLock } from "@/nextsignal/services/database";
import {
  redact,
  loggerAdapter,
  replayLogs,
} from "@/nextsignal/adapters/logger";
import { sessionToken, validSession } from "@/nextsignal/adapters/auth";
import type { CatalogRow, Run } from "@/nextsignal/domain/types";
const row = (key: string, price: string): CatalogRow => ({
  key,
  name: `Milk ${key}`,
  description: null,
  category: null,
  gtin: null,
  price,
  regular_price: null,
  promo_price: null,
  unit_price: null,
  available: null,
  promotion: null,
  source_updated_at: null,
  raw: {},
});
beforeAll(() => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Integration tests require the dedicated test database");
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE retailers,sources,runs,staging,artifacts,products,listings,offers,match_decisions,ai_cache,ai_usage,logs,login_attempts,host_limits CASCADE",
  );
  await seedRetailers();
});
afterAll(() => pool.end());
it("spools a failed database log write and replays it once after recovery", async () => {
  const message = `spool-recovery-${randomUUID()}`;
  const query = vi
    .spyOn(pool, "query")
    .mockRejectedValueOnce(new Error("database unavailable"));
  await loggerAdapter.error({ message, data: { api_key: "sensitive" } });
  query.mockRestore();
  const files = await readdir(settings.logging.spool_dir);
  const entries = await Promise.all(
    files.map(async (file) =>
      JSON.parse(
        await readFile(join(settings.logging.spool_dir, file), "utf8"),
      ),
    ),
  );
  expect(entries.find((entry) => entry.message === message)?.data.api_key).toBe(
    "[REDACTED]",
  );
  await replayLogs();
  await replayLogs();
  expect(
    (await pool.query("SELECT * FROM logs WHERE message=$1", [message]))
      .rowCount,
  ).toBe(1);
});
it("keeps replaying valid logs after a malformed spool entry", async () => {
  const file = `000-invalid-${randomUUID()}.json`;
  const path = join(settings.logging.spool_dir, file);
  await writeFile(path, "{unfinished", { mode: 0o600 });
  const message = `after-corruption-${randomUUID()}`;
  const query = vi
    .spyOn(pool, "query")
    .mockRejectedValueOnce(new Error("database unavailable"));
  await loggerAdapter.error({ message });
  query.mockRestore();
  await replayLogs();
  expect(
    (await pool.query("SELECT * FROM logs WHERE message=$1", [message]))
      .rowCount,
  ).toBe(1);
  expect(await readFile(`${path}.invalid`, "utf8")).toBe("{unfinished");
  await unlink(`${path}.invalid`);
});
it("recovers an interrupted spool rename without reading an active write", async () => {
  const id = randomUUID();
  const path = join(settings.logging.spool_dir, `${id}.tmp`);
  await writeFile(
    path,
    JSON.stringify({
      id,
      level: "error",
      message: "interrupted spool rename",
      created_at: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  await replayLogs();
  expect(
    (await pool.query("SELECT id FROM logs WHERE id=$1", [id])).rowCount,
  ).toBe(0);
  const old = new Date(Date.now() - settings.scheduler.tick_ms - 1);
  await utimes(path, old, old);
  await replayLogs();
  await replayLogs();
  expect(
    (await pool.query("SELECT id FROM logs WHERE id=$1", [id])).rowCount,
  ).toBe(1);
});
it("rejects unknown configuration keys instead of ignoring misspellings", () => {
  expect(configSchema.safeParse({ ...settings, schedulerr: {} }).success).toBe(
    false,
  );
  expect(
    configSchema.safeParse({
      ...settings,
      queue: { ...settings.queue, concurency: 4 },
    }).success,
  ).toBe(false);
  expect(
    configSchema.safeParse({
      ...settings,
      scheduler: { ...settings.scheduler, cron: "*/10 * * * * *" },
    }).success,
  ).toBe(false);
});
it("waits for active ingestion before issuing a single scheduled catch-up", async () => {
  const active = await createRun("discover", "spar", null, null);
  await pool.query(
    "UPDATE retailers SET next_due='2026-10-19T10:00:00Z' WHERE slug='spar'",
  );
  const now = new Date("2026-10-20T10:00:00Z");
  await enqueueDue(now);
  expect(
    (await pool.query("SELECT * FROM runs WHERE retailer='spar'")).rowCount,
  ).toBe(1);
  await pool.query("UPDATE runs SET status='success' WHERE id=$1", [active.id]);
  await enqueueDue(now);
  await enqueueDue(now);
  expect(
    (
      await pool.query(
        "SELECT * FROM runs WHERE retailer='spar' AND scheduled_for IS NOT NULL",
      )
    ).rowCount,
  ).toBe(1);
});
async function catalog() {
  const parent = await createRun("discover", "spar", null, null);
  await saveDiscovery(parent, [
    {
      retailer: "spar",
      external_id: "test",
      name: "Test source",
      url: "https://spar.mk/pricelist/1",
      scope: "branch",
      meta: {},
    },
  ]);
  return (await pool.query<Run>("SELECT * FROM runs WHERE kind='catalog'"))
    .rows[0];
}
async function stage(
  run: Run,
  rows: CatalogRow[],
  done = true,
  total: number | null = null,
) {
  await stagePage(run, {
    rows,
    next: done ? null : "2",
    total,
    artifact: null,
  });
  return publishCatalog(await getRun(run.id));
}
it("publishes idempotently and preserves last good catalog on partial retrieval", async () => {
  const r = await catalog();
  await stage(r, [row("a", "65.00"), row("b", "70.00")]);
  await publishCatalog(await getRun(r.id));
  expect((await pool.query("SELECT * FROM offers")).rowCount).toBe(2);
  expect(
    (await pool.query("SELECT * FROM runs WHERE kind='match'")).rowCount,
  ).toBe(1);
  const partial = await createRun("catalog", "spar", r.source_id, null);
  await expect(stage(partial, [row("a", "60.00")], false)).rejects.toThrow(
    "incomplete",
  );
  expect(
    (await pool.query("SELECT price FROM offers ORDER BY price")).rows[0].price,
  ).toBe("65.00");
});
it("rejects inconsistent advertised counts and conflicting duplicate identifiers", async () => {
  const policy = settings.sources.spar.identity_policy;
  settings.sources.spar.identity_policy = "strict";
  try {
    const r = await catalog();
    await expect(stage(r, [row("a", "65.00")], true, 2)).rejects.toThrow(
      "count mismatch",
    );
    await expect(
      stagePage(r, {
        rows: [row("a", "80.00")],
        next: null,
        total: null,
        artifact: null,
      }),
    ).rejects.toThrow("Conflicting duplicate");
  } finally {
    settings.sources.spar.identity_policy = policy;
  }
});
it("preserves SPAR's repeated article codes and validates the complete row count", async () => {
  const { parseSpar } = await import("@/nextsignal/services/parsers");
  const input = JSON.parse(
    await readFile("tests/fixtures/spar-duplicate.json", "utf8"),
  );
  const rows = parseSpar(input.rows);
  const run = await catalog();
  await stagePage(run, {
    rows: rows.slice(0, 1),
    next: "2",
    total: 2,
    artifact: null,
  });
  await stagePage(run, {
    rows: rows.slice(1),
    next: null,
    total: 2,
    artifact: null,
  });
  await publishCatalog(await getRun(run.id));
  expect(
    (await pool.query("SELECT price FROM offers ORDER BY price")).rows,
  ).toEqual([{ price: "109.00" }, { price: "149.00" }]);
  expect(
    (await pool.query("SELECT raw,attributes FROM listings")).rows.every(
      (r) => r.raw.id === 41191 && r.attributes.ambiguous === true,
    ),
  ).toBe(true);
  const enabled = settings.matching.ai.enabled;
  const fetchMock = vi
    .fn()
    .mockRejectedValue(
      new Error("Ambiguous source rows must not incur AI work"),
    );
  vi.stubGlobal("fetch", fetchMock);
  settings.matching.ai.enabled = true;
  try {
    const { matchBatch } = await import("@/nextsignal/services/matching");
    const match = await createRun("match", "spar", run.source_id, run.id);
    await matchBatch(match.id, run.source_id);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (await pool.query("SELECT method FROM match_decisions")).rows,
    ).toEqual([{ method: "ambiguous" }, { method: "ambiguous" }]);
  } finally {
    settings.matching.ai.enabled = enabled;
    vi.unstubAllGlobals();
  }
});
it("bulk-records known ambiguity with configured bounds and zero model calls across workers", async () => {
  const run = await catalog();
  await stage(
    run,
    Array.from({ length: 120 }, () => row("repeat", "65.00")),
  );
  const matching = await createRun("match", "spar", run.source_id, run.id);
  const before = {
    ai: settings.matching.ai.enabled,
    batch: settings.matching.batch_size,
    ambiguity: settings.matching.ambiguity_batch_size,
  };
  const fetchMock = vi
    .fn()
    .mockRejectedValue(new Error("Known ambiguity must not use AI"));
  vi.stubGlobal("fetch", fetchMock);
  settings.matching.ai.enabled = true;
  settings.matching.batch_size = 1;
  settings.matching.ambiguity_batch_size = 64;
  try {
    const { matchBatch } = await import("@/nextsignal/services/matching");
    const batches = await Promise.all([
      matchBatch(matching.id, run.source_id),
      matchBatch(matching.id, run.source_id),
    ]);
    expect(
      batches.every((batch) => batch.ambiguous > 0 && batch.ambiguous <= 64),
    ).toBe(true);
    expect(batches.reduce((sum, batch) => sum + batch.processed, 0)).toBe(120);
    expect(
      (
        await pool.query(
          "SELECT * FROM match_decisions WHERE method='ambiguous' AND model IS NULL",
        )
      ).rowCount,
    ).toBe(120);
    expect(
      (
        await pool.query(
          "SELECT count(DISTINCT product_id)::int AS n FROM listings",
        )
      ).rows[0].n,
    ).toBe(120);
    expect((await matchBatch(matching.id, run.source_id)).processed).toBe(0);
    expect((await pool.query("SELECT * FROM match_decisions")).rowCount).toBe(
      120,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    settings.matching.ai.enabled = before.ai;
    settings.matching.batch_size = before.batch;
    settings.matching.ambiguity_batch_size = before.ambiguity;
    vi.unstubAllGlobals();
  }
});
it("requires explicit rate configuration for every configured source host", () => {
  const intervals = { ...settings.http.host_intervals_ms };
  delete intervals["api.prod.spar.mk"];
  expect(
    configSchema.safeParse({
      ...settings,
      http: { ...settings.http, host_intervals_ms: intervals },
    }).success,
  ).toBe(false);
});
it("creates retries with fresh source provenance and no partial checkpoint", async () => {
  const run = await catalog();
  await stagePage(run, {
    rows: [row("a", "65.00")],
    next: "2",
    total: 2,
    artifact: null,
  });
  await pool.query("UPDATE runs SET status='failed' WHERE id=$1", [run.id]);
  await pool.query(
    "UPDATE sources SET url='https://spar.mk/pricelist/2' WHERE id=$1",
    [run.source_id],
  );
  const { retryRun } = await import("@/nextsignal/services/operations");
  const retried = await retryRun(run.id);
  expect(retried.checkpoint).toEqual({
    source_url: "https://spar.mk/pricelist/2",
  });
  expect(retried.id).not.toBe(run.id);
});
it("rejects missing parser endpoints and unsupported page sizes at startup", () => {
  for (const patch of [{ api_url: null }, { page_size: 501 }])
    expect(
      configSchema.safeParse({
        ...settings,
        sources: {
          ...settings.sources,
          spar: { ...settings.sources.spar, ...patch },
        },
      }).success,
    ).toBe(false);
  expect(
    configSchema.safeParse({
      ...settings,
      sources: {
        ...settings.sources,
        zito: { ...settings.sources.zito, page_size: 500 },
      },
    }).success,
  ).toBe(false);
});
it("confirms catalog reductions before removing offers", async () => {
  const r = await catalog();
  await stage(r, [row("a", "65.00"), row("b", "70.00")]);
  const reduced = await createRun("catalog", "spar", r.source_id, null);
  expect((await stage(reduced, [row("a", "65.00")])).status).toBe(
    "quarantined",
  );
  expect((await pool.query("SELECT * FROM offers")).rowCount).toBe(2);
  const confirm = (
    await pool.query<Run>(
      "SELECT * FROM runs WHERE checkpoint->>'confirmation_of'=$1",
      [reduced.id],
    )
  ).rows[0];
  expect((await stage(confirm, [row("a", "65.00")])).status).toBe("success");
  expect((await pool.query("SELECT * FROM offers")).rowCount).toBe(1);
});
it("prevents older jobs overwriting newer prices", async () => {
  const old = await catalog();
  const newer = await createRun("catalog", "spar", old.source_id, null);
  await pool.query(
    "UPDATE runs SET created_at=CASE WHEN id=$1 THEN '2026-10-20T12:00:00.000100Z'::timestamptz ELSE '2026-10-20T12:00:00.000200Z'::timestamptz END WHERE id=ANY($2::uuid[])",
    [old.id, [old.id, newer.id]],
  );
  await stage(newer, [row("a", "90.00")]);
  expect((await stage(old, [row("a", "60.00")])).status).toBe("superseded");
  expect((await pool.query("SELECT price FROM offers")).rows[0].price).toBe(
    "90.00",
  );
});
it("serializes competing source workers", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const start = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const first = withLock("test-lock", async () => {
    ready();
    await wait;
    return true;
  });
  await start;
  expect(await withLock("test-lock", async () => true)).toBeNull();
  release();
  expect(await first).toBe(true);
});
it("queues one catch-up occurrence across concurrent scheduler ticks", async () => {
  await pool.query(
    "UPDATE retailers SET next_due='2020-01-01' WHERE slug='spar'",
  );
  await Promise.all([enqueueDue(new Date()), enqueueDue(new Date())]);
  expect(
    (await pool.query("SELECT * FROM runs WHERE kind='discover'")).rowCount,
  ).toBe(1);
});
it("applies timezone and retailer cron changes without inventing a catch-up run", async () => {
  const timezone = settings.app.timezone;
  const expression = settings.sources.spar.cron;
  const now = new Date("2026-10-20T10:00:00Z");
  const due = async () =>
    (
      await pool.query("SELECT next_due FROM retailers WHERE slug='spar'")
    ).rows[0].next_due.toISOString();
  try {
    await enqueueDue(now);
    expect(await due()).toBe("2026-10-26T11:00:00.000Z");
    settings.app.timezone = "UTC";
    await seedRetailers();
    await enqueueDue(now);
    expect(await due()).toBe("2026-10-26T12:00:00.000Z");
    settings.sources.spar.cron = "0 9 * * *";
    await seedRetailers();
    await enqueueDue(now);
    expect(await due()).toBe("2026-10-21T09:00:00.000Z");
    expect((await pool.query("SELECT * FROM runs")).rowCount).toBe(0);
  } finally {
    settings.app.timezone = timezone;
    settings.sources.spar.cron = expression;
  }
});
it("skips overdue runs when catch-up is explicitly disabled", async () => {
  const catchUp = settings.scheduler.catch_up;
  try {
    settings.scheduler.catch_up = false;
    await pool.query(
      "UPDATE retailers SET next_due='2026-10-19T10:00:00Z' WHERE slug='spar'",
    );
    await enqueueDue(new Date("2026-10-20T10:00:00Z"));
    expect((await pool.query("SELECT * FROM runs")).rowCount).toBe(0);
    expect(
      (
        await pool.query("SELECT next_due FROM retailers WHERE slug='spar'")
      ).rows[0].next_due.toISOString(),
    ).toBe("2026-10-26T11:00:00.000Z");
  } finally {
    settings.scheduler.catch_up = catchUp;
  }
});
it("keeps wall-clock schedules stable across DST", () => {
  expect(
    nextOccurrence(
      "0 12 * * 1",
      "Europe/Skopje",
      new Date("2026-10-23T00:00:00Z"),
    ).toISOString(),
  ).toBe("2026-10-26T11:00:00.000Z");
});
it("fails validation on missing required settings and parses explicit false", () => {
  const data = structuredClone(settings);
  delete (data.database as Partial<typeof data.database>).pool_size;
  expect(configSchema.safeParse(data).success).toBe(false);
  expect(
    configSchema.parse({
      ...settings,
      matching: {
        ...settings.matching,
        ai: { ...settings.matching.ai, enabled: "false" },
      },
    }).matching.ai.enabled,
  ).toBe(false);
});
it("rejects forged sessions and redacts nested secrets", () => {
  const token = sessionToken();
  expect(validSession(token)).toBe(true);
  expect(validSession(token + "x")).toBe(false);
  expect(
    redact({
      password: "sensitive",
      nested: { authorization: "Bearer secret" },
      message: "postgresql://u:p@host/db",
    }),
  ).toEqual({
    password: "[REDACTED]",
    nested: { authorization: "[REDACTED]" },
    message: "postgresql://[REDACTED]",
  });
});

it("preserves repeated indistinguishable source rows as separate listings", async () => {
  const parent = await createRun("discover", "zito", null, null);
  await saveDiscovery(parent, [
    {
      retailer: "zito",
      external_id: "duplicate-test",
      name: "Duplicate source",
      url: "https://zito.proverkanaceni.mk/",
      scope: "branch",
      meta: {},
    },
  ]);
  const run = (await pool.query<Run>("SELECT * FROM runs WHERE kind='catalog'"))
    .rows[0];
  await stagePage(run, {
    rows: [row("same", "65.00")],
    next: "2",
    total: null,
    artifact: null,
  });
  await stagePage(run, {
    rows: [row("same", "70.00")],
    next: null,
    total: null,
    artifact: null,
  });
  await publishCatalog(await getRun(run.id));
  expect((await pool.query("SELECT * FROM offers")).rowCount).toBe(2);
  expect(
    (
      await pool.query(
        "SELECT attributes->>'ambiguous' AS ambiguous FROM listings",
      )
    ).rows.every((r) => r.ambiguous === "true"),
  ).toBe(true);
});
it("recovers an orphaned running job after a worker exits", async () => {
  const run = await catalog();
  await pool.query("UPDATE runs SET status='running' WHERE id=$1", [run.id]);
  await recoverOrphans();
  expect((await getRun(run.id)).status).toBe("pending");
  await pool.query("UPDATE runs SET status='running' WHERE id=$1", [run.id]);
  await withLock(`run:${run.id}`, async () => {
    await recoverOrphans();
    expect((await getRun(run.id)).status).toBe("running");
  });
});
it("acknowledges duplicate delivery while preserving orphan recovery", async () => {
  const run = await catalog();
  await pool.query("UPDATE runs SET status='running' WHERE id=$1", [run.id]);
  const { app } = await import("@/nextsignal/app");
  await withLock(`run:${run.id}`, async () => {
    expect((await app.dispatch("catalog.execute", { run_id: run.id })).ok).toBe(
      true,
    );
    expect((await getRun(run.id)).status).toBe("running");
  });
  await recoverOrphans();
  expect((await getRun(run.id)).status).toBe("pending");
});
it("automatically queues a fresh snapshot after an upstream change without replacing current prices", async () => {
  const baseline = await catalog();
  await stage(baseline, [row("a", "65.00"), row("b", "70.00")]);
  const run = await createRun(
    "catalog",
    "spar",
    baseline.source_id,
    baseline.parent_id,
  );
  await stagePage(run, {
    rows: [{ ...row("a", "80.00"), source_updated_at: "2026-10-20T12:00:00Z" }],
    next: "2",
    total: 2,
    artifact: null,
  });
  const importers = await import("@/nextsignal/services/importers");
  const retrieval = vi
    .spyOn(importers, "retrieve")
    .mockImplementation(async function* () {
      yield {
        rows: [
          { ...row("b", "85.00"), source_updated_at: "2026-10-20T13:00:00Z" },
        ],
        next: null,
        total: 2,
        artifact: null,
      };
    });
  try {
    const { app } = await import("@/nextsignal/app");
    expect((await app.dispatch("catalog.execute", { run_id: run.id })).ok).toBe(
      true,
    );
    expect((await getRun(run.id)).status).toBe("superseded");
    const next = (
      await pool.query<Run>(
        "SELECT * FROM runs WHERE checkpoint->>'restarts_run'=$1",
        [run.id],
      )
    ).rows[0];
    expect(next.status).toBe("pending");
    expect(next.checkpoint).toEqual({
      source_url: "https://spar.mk/pricelist/1",
      source_restarts: 1,
      restarts_run: run.id,
    });
    expect(
      (
        await pool.query("SELECT count(*) AS n FROM staging WHERE run_id=$1", [
          next.id,
        ])
      ).rows[0].n,
    ).toBe("0");
    expect(
      (await pool.query("SELECT price FROM offers ORDER BY price")).rows,
    ).toEqual([{ price: "65.00" }, { price: "70.00" }]);
    expect(
      (await restartCatalog(await getRun(run.id), "duplicate delivery"))?.id,
    ).toBe(next.id);
    expect(
      (
        await pool.query(
          "SELECT * FROM runs WHERE checkpoint->>'restarts_run'=$1",
          [run.id],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    retrieval.mockRestore();
  }
});
it("bounds automatic snapshot restarts using the configured retry limit", async () => {
  const run = await catalog();
  await stagePage(run, {
    rows: [{ ...row("a", "65.00"), source_updated_at: "2026-10-20T12:00:00Z" }],
    next: "2",
    total: 2,
    artifact: null,
  });
  await pool.query(
    "UPDATE runs SET checkpoint=jsonb_set(checkpoint,'{source_restarts}',$2::jsonb) WHERE id=$1",
    [run.id, JSON.stringify(settings.queue.retry_limit)],
  );
  const importers = await import("@/nextsignal/services/importers");
  const retrieval = vi
    .spyOn(importers, "retrieve")
    .mockImplementation(async function* () {
      yield {
        rows: [
          { ...row("b", "70.00"), source_updated_at: "2026-10-20T13:00:00Z" },
        ],
        next: null,
        total: 2,
        artifact: null,
      };
    });
  try {
    const { app } = await import("@/nextsignal/app");
    expect((await app.dispatch("catalog.execute", { run_id: run.id })).ok).toBe(
      true,
    );
    expect((await getRun(run.id)).status).toBe("failed");
    expect(
      (
        await pool.query(
          "SELECT * FROM runs WHERE checkpoint->>'restarts_run'=$1",
          [run.id],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    retrieval.mockRestore();
  }
});
it("skips obsolete deliveries and their snapshot restarts before fetching any pages", async () => {
  const old = await catalog();
  const newer = await createRun(
    "catalog",
    "spar",
    old.source_id,
    old.parent_id,
  );
  await pool.query(
    "UPDATE runs SET created_at=CASE WHEN id=$1 THEN '2026-10-20T12:00:00.000100Z'::timestamptz ELSE '2026-10-20T12:00:00.000200Z'::timestamptz END WHERE id=ANY($2::uuid[])",
    [old.id, [old.id, newer.id]],
  );
  await stage(newer, [row("current", "70.00")]);
  const importers = await import("@/nextsignal/services/importers");
  const retrieval = vi
    .spyOn(importers, "retrieve")
    .mockImplementation(async function* () {
      throw new Error("An obsolete delivery must not fetch");
    });
  try {
    const { app } = await import("@/nextsignal/app");
    expect((await app.dispatch("catalog.execute", { run_id: old.id })).ok).toBe(
      true,
    );
    expect((await getRun(old.id)).status).toBe("superseded");
    const skipped = await restartCatalog(
      await getRun(old.id),
      "old snapshot changed",
    );
    expect(skipped?.id).toBe(old.id);
    expect(skipped?.status).toBe("superseded");
    expect(
      (
        await pool.query(
          "SELECT * FROM runs WHERE checkpoint->>'restarts_run'=$1",
          [old.id],
        )
      ).rowCount,
    ).toBe(0);
    expect(retrieval).not.toHaveBeenCalled();
    expect((await pool.query("SELECT price FROM offers")).rows[0].price).toBe(
      "70.00",
    );
  } finally {
    retrieval.mockRestore();
  }
});
it("creates only one replacement snapshot across competing workers", async () => {
  const run = await catalog();
  const replacements = await Promise.all([
    restartCatalog(run, "upstream changed"),
    restartCatalog(run, "upstream changed"),
  ]);
  expect(replacements[0]?.id).toBe(replacements[1]?.id);
  expect(
    (
      await pool.query(
        "SELECT * FROM runs WHERE checkpoint->>'restarts_run'=$1",
        [run.id],
      )
    ).rowCount,
  ).toBe(1);
});
it("only uses configured snapshot timestamps to reject changed pagination", async () => {
  const run = await catalog();
  const policy = settings.sources.spar.timestamp_policy;
  try {
    await stagePage(run, {
      rows: [{ ...row("a", "65"), source_updated_at: "2026-10-20T12:00:00Z" }],
      next: "2",
      total: null,
      artifact: null,
    });
    const page = {
      rows: [{ ...row("b", "70"), source_updated_at: "2026-10-20T12:01:00Z" }],
      next: null,
      total: null,
      artifact: null,
    };
    await expect(stagePage(run, page)).rejects.toThrow("Source changed");
    settings.sources.spar.timestamp_policy = "observed";
    await stagePage(run, page);
    await publishCatalog(await getRun(run.id));
    expect(
      (await pool.query("SELECT DISTINCT source_updated_at FROM offers"))
        .rowCount,
    ).toBe(2);
  } finally {
    settings.sources.spar.timestamp_policy = policy;
  }
});
it("joins multiple proven identities and preserves old product references", async () => {
  const run = await catalog();
  await stage(
    run,
    ["a", "b", "c"].map((k) => ({ ...row(k, "65.00"), gtin: "4006381333931" })),
  );
  const oldIds = (await pool.query("SELECT id FROM products")).rows.map(
    (r) => r.id,
  );
  const { matchBatch } = await import("@/nextsignal/services/matching");
  const matchRun = await createRun("match", "spar", run.source_id, run.id);
  await matchBatch(matchRun.id, run.source_id);
  expect(
    Number(
      (await pool.query("SELECT count(DISTINCT product_id) AS n FROM listings"))
        .rows[0].n,
    ),
  ).toBe(1);
  const { offersForProduct } = await import("@/nextsignal/services/operations");
  for (const id of oldIds) expect((await offersForProduct(id)).length).toBe(3);
});
it("connects listings from different retailers while preserving each offer", async () => {
  const first = await catalog();
  await stage(first, [{ ...row("milk-spar", "65.00"), gtin: "4006381333931" }]);
  const discovery = await createRun("discover", "zur", null, null);
  await saveDiscovery(discovery, [
    {
      retailer: "zur",
      external_id: "cross-retailer",
      name: "Žur test branch",
      url: "https://ceni.zur.mk/",
      scope: "branch",
      meta: {},
    },
  ]);
  const second = (
    await pool.query<Run>(
      "SELECT * FROM runs WHERE retailer='zur' AND kind='catalog'",
    )
  ).rows[0];
  await stage(second, [
    { ...row("milk-zur", "60.00"), name: "Млеко", gtin: "4006381333931" },
  ]);
  const { matchBatch } = await import("@/nextsignal/services/matching");
  const matching = await createRun("match", "zur", second.source_id, second.id);
  await matchBatch(matching.id, second.source_id);
  const productIds = (
    await pool.query("SELECT DISTINCT product_id FROM listings")
  ).rows;
  expect(productIds).toHaveLength(1);
  const { offersForProduct } = await import("@/nextsignal/services/operations");
  const offers = await offersForProduct(productIds[0].product_id);
  expect(offers.map((offer) => [offer.retailer, offer.price])).toEqual([
    ["zur", "60.00"],
    ["spar", "65.00"],
  ]);
});
it("does not link conflicting variants even when a retailer repeats a barcode", async () => {
  const run = await catalog();
  await stage(run, [
    {
      ...row("classic", "65.00"),
      name: "КОКА КОЛА КЛАСИК 330МЛ",
      gtin: "4006381333931",
    },
    {
      ...row("zero", "65.00"),
      name: "КОКА КОЛА ЗЕРО 330МЛ",
      gtin: "4006381333931",
    },
  ]);
  const { matchBatch } = await import("@/nextsignal/services/matching");
  const m = await createRun("match", "spar", run.source_id, run.id);
  await matchBatch(m.id, run.source_id);
  expect(
    Number(
      (await pool.query("SELECT count(DISTINCT product_id) AS n FROM listings"))
        .rows[0].n,
    ),
  ).toBe(2);
});
it("keeps incomplete identities due while AI is disabled without rewriting them", async () => {
  const run = await catalog();
  await stage(run, [row("unknown", "65.00")]);
  const before = (await pool.query("SELECT * FROM listings")).rows[0];
  const ai = await import("@/nextsignal/services/ai");
  const extraction = vi.spyOn(ai, "extractAttributes").mockResolvedValue(null);
  const { matchBatch } = await import("@/nextsignal/services/matching");
  const match = await createRun("match", "spar", run.source_id, run.id);
  const enabled = settings.matching.ai.enabled;
  try {
    settings.matching.ai.enabled = false;
    expect(await matchBatch(match.id, run.source_id)).toMatchObject({
      processed: 0,
      ai_disabled: true,
      more: false,
    });
    expect((await pool.query("SELECT * FROM listings")).rows[0]).toEqual(
      before,
    );
    settings.matching.ai.enabled = true;
    expect((await matchBatch(match.id, run.source_id)).processed).toBe(1);
    expect(extraction).toHaveBeenCalledTimes(1);
  } finally {
    settings.matching.ai.enabled = enabled;
    extraction.mockRestore();
  }
});
it("searches normalized product names using Cyrillic or Latin while retaining the original", async () => {
  const run = await catalog();
  await stage(run, [{ ...row("milk", "65.00"), name: "МЛЕКО АЛПСКО 1Л" }]);
  const { readDashboard } = await import("@/nextsignal/services/operations");
  const { refreshBrowser } =
    await import("@/nextsignal/services/catalog-browser");
  await refreshBrowser();
  for (const search of ["МЛЕКО", "mleko"]) {
    const rows = await readDashboard({
      view: "products",
      search,
      page: 1,
      size: settings.dashboard.page_size,
    });
    if (!rows || typeof rows !== "object" || !("rows" in rows))
      throw new Error("Expected paginated product search results");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].name).toBe("МЛЕКО АЛПСКО 1Л");
  }
});
it("reuses saved connections on repeat imports with zero provider calls", async () => {
  const enabled = settings.matching.ai.enabled;
  const fetchMock = vi
    .fn()
    .mockRejectedValue(new Error("Unexpected paid request"));
  vi.stubGlobal("fetch", fetchMock);
  settings.matching.ai.enabled = true;
  try {
    const run = await catalog();
    const rows = ["a", "b"].map((key) => ({
      ...row(key, "65.00"),
      gtin: "4006381333931",
    }));
    await stage(run, rows);
    const { matchBatch } = await import("@/nextsignal/services/matching");
    const first = await createRun("match", "spar", run.source_id, run.id);
    await matchBatch(first.id, run.source_id);
    const before = (
      await pool.query(
        "SELECT id,product_id,identity_hash,matched_hash FROM listings ORDER BY id",
      )
    ).rows;
    expect(new Set(before.map((listing) => listing.product_id)).size).toBe(1);
    const decisions = (
      await pool.query("SELECT count(*) AS n FROM match_decisions")
    ).rows[0].n;
    const repeat = await createRun("catalog", "spar", run.source_id, null);
    await stage(
      repeat,
      rows.map((r) => ({ ...r, price: "80.00", available: false })),
    );
    // Even explicitly making the records due does not invalidate their saved identity.
    await pool.query("UPDATE listings SET next_match_at=now()");
    const second = await createRun("match", "spar", run.source_id, repeat.id);
    expect((await matchBatch(second.id, run.source_id)).processed).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT id,product_id,identity_hash,matched_hash FROM listings ORDER BY id",
        )
      ).rows,
    ).toEqual(before);
    expect(
      (await pool.query("SELECT count(*) AS n FROM match_decisions")).rows[0].n,
    ).toBe(decisions);
    expect(
      (await pool.query("SELECT price,available FROM offers")).rows,
    ).toEqual([
      { price: "80.00", available: false },
      { price: "80.00", available: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    settings.matching.ai.enabled = enabled;
    vi.unstubAllGlobals();
  }
});
it("preserves a connection committed while an unchanged catalog is being published", async () => {
  const initial = await catalog();
  const rows = [row("a", "65.00"), row("b", "70.00")];
  await stage(initial, rows);
  const products = (
    await pool.query("SELECT id FROM products ORDER BY created_at,id")
  ).rows;
  const target = products[0].id,
    previous = products[1].id;
  const repeat = await createRun("catalog", "spar", initial.source_id, null);
  await stagePage(repeat, {
    rows: rows.map((r) => ({ ...r, price: "80.00" })),
    next: null,
    total: null,
    artifact: null,
  });
  const merger = await pool.connect();
  let publication: Promise<unknown> | undefined;
  try {
    await merger.query("BEGIN");
    await merger.query(
      "UPDATE listings SET product_id=$1,match_status='matched',matched_hash=identity_hash",
      [target],
    );
    publication = publishCatalog(await getRun(repeat.id));
    const deadline = Date.now() + testing.timeout_ms / 2;
    let blocked = false;
    while (Date.now() < deadline) {
      blocked =
        (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO listings%' LIMIT 1",
          )
        ).rowCount === 1;
      if (blocked) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(blocked).toBe(true);
    await merger.query("UPDATE products SET redirect_id=$2 WHERE id=$1", [
      previous,
      target,
    ]);
    await merger.query("COMMIT");
    await publication;
    expect(
      (await pool.query("SELECT DISTINCT product_id FROM listings")).rows,
    ).toEqual([{ product_id: target }]);
  } finally {
    await merger.query("ROLLBACK");
    merger.release();
    if (publication) await publication;
  }
});
it("keeps an unchanged abstention without repeating AI until explicitly retried", async () => {
  const run = await catalog();
  await stage(run, [row("uncertain", "65.00")]);
  await pool.query(
    "UPDATE listings SET matched_hash=identity_hash,next_match_at=now()-interval '1 hour'",
  );
  const repeat = await createRun("catalog", "spar", run.source_id, null);
  await stage(repeat, [row("uncertain", "70.00")]);
  const { matchBatch } = await import("@/nextsignal/services/matching");
  const match = await createRun("match", "spar", run.source_id, repeat.id);
  expect((await matchBatch(match.id, run.source_id)).processed).toBe(0);
});
it("keeps the published source URL when discovery advances before a failed import", async () => {
  const initial = await catalog();
  await stage(initial, [row("a", "65.00"), row("b", "70.00")]);
  const original = (await pool.query("SELECT source_url FROM offers LIMIT 1"))
    .rows[0].source_url;
  await pool.query("UPDATE sources SET url=$2 WHERE id=$1", [
    initial.source_id,
    "https://spar.mk/pricelist/updated",
  ]);
  const later = await createRun("catalog", "spar", initial.source_id, null);
  await expect(stage(later, [row("a", "80.00")], false)).rejects.toThrow(
    "incomplete",
  );
  expect(
    (await pool.query("SELECT DISTINCT source_url FROM offers")).rows,
  ).toEqual([{ source_url: original }]);
  await stage(later, [row("a", "80.00"), row("b", "85.00")]);
  expect(
    (await pool.query("SELECT DISTINCT source_url FROM offers")).rows,
  ).toEqual([{ source_url: "https://spar.mk/pricelist/updated" }]);
});
it("honors a disabled retailer before making a retrieval request", async () => {
  const run = await catalog(),
    enabled = settings.sources.spar.enabled;
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  settings.sources.spar.enabled = false;
  try {
    const { app } = await import("@/nextsignal/app");
    expect((await app.dispatch("catalog.execute", { run_id: run.id })).ok).toBe(
      true,
    );
    expect((await getRun(run.id)).status).toBe("superseded");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    settings.sources.spar.enabled = enabled;
    vi.unstubAllGlobals();
  }
});
it("browses unique retailer articles with exact page totals and retained unusable records", async () => {
  const parent = await createRun("discover", "spar", null, null);
  await saveDiscovery(
    parent,
    ["one", "two"].map((id) => ({
      retailer: "spar" as const,
      external_id: id,
      name: id,
      url: `https://spar.mk/pricelist/${id}`,
      scope: "branch" as const,
      meta: {},
    })),
  );
  const catalogs = (
    await pool.query<Run>(
      "SELECT * FROM runs WHERE kind='catalog' ORDER BY created_at,id",
    )
  ).rows;
  for (const [index, run] of catalogs.entries())
    await stage(run, [
      {
        ...row("cola", index === 0 ? "49.00" : "59.00"),
        name: "Coca Cola Zero Can 330ml",
      },
      { ...row("bad", "74.00"), name: "*" },
      { ...row("dot", "12.00"), name: "." },
      { ...row("milk", "70.00"), name: "Milk Test 1L" },
    ]);
  const { refreshBrowser } =
    await import("@/nextsignal/services/catalog-browser");
  expect(await refreshBrowser()).toBe(true);
  const { readDashboard, offersForProduct } =
    await import("@/nextsignal/services/operations");
  const result = await readDashboard({
    view: "products",
    search: "",
    page: 1,
    size: 1,
  });
  if (!result || !("rows" in result)) throw new Error("Expected table page");
  expect(result).toMatchObject({
    view: "products",
    total: 2,
    total_pages: 2,
    page: 1,
  });
  expect(result.rows[0]).toMatchObject({
    name: "Coca Cola Zero Can 330ml",
    price: "49.00",
    highest_price: "59.00",
    catalog_count: 2,
    offer_count: 2,
  });
  expect(
    await offersForProduct(String(result.rows[0].product_id)),
  ).toHaveLength(2);
  const invalid = await readDashboard({
    view: "products",
    search: "",
    page: 1,
    size: 30,
    name_quality: "invalid",
  });
  expect(invalid).toMatchObject({ total: 2 });
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM offers")).rows[0].n,
  ).toBe(8);
});
it("filters matching evidence by retailer and returns its own typed page", async () => {
  const run = await catalog();
  await stage(run, [row("a", "65.00")]);
  const listing = (await pool.query("SELECT id,identity_hash FROM listings"))
    .rows[0];
  await pool.query(
    "INSERT INTO match_decisions(listing_id,identity_hash,method,evidence,prompt_version) VALUES($1,$2,'separate','{}','test')",
    [listing.id, listing.identity_hash],
  );
  const { readDashboard } = await import("@/nextsignal/services/operations");
  expect(
    await readDashboard({
      view: "decisions",
      search: "",
      page: 1,
      size: 30,
      retailer: "kam",
    }),
  ).toMatchObject({ view: "decisions", rows: [], total: 0, total_pages: 0 });
  const result = await readDashboard({
    view: "decisions",
    search: "",
    page: 1,
    size: 30,
    retailer: "spar",
  });
  if (!result || !("rows" in result)) throw new Error("Expected table page");
  expect(result.rows[0]).toMatchObject({
    method: "separate",
    probability: null,
    retailer: "spar",
  });
});
it("matches equivalent retailer products with local rules and reuses the result across branch copies without AI", async () => {
  const spar = await catalog();
  await stage(spar, [
    { ...row("cola", "49.00"), name: "Coca Cola Zero Can 330ml" },
  ]);
  const parent = await createRun("discover", "kam", null, null);
  await saveDiscovery(
    parent,
    ["one", "two"].map((id) => ({
      retailer: "kam" as const,
      external_id: id,
      name: id,
      url: `https://kam.com.mk/${id}`,
      scope: "branch" as const,
      meta: {},
    })),
  );
  const runs = (
    await pool.query<Run>(
      "SELECT * FROM runs WHERE retailer='kam' AND kind='catalog'",
    )
  ).rows;
  for (const run of runs)
    await stage(run, [
      { ...row("cola", "55.00"), name: "СОК КОКА КОЛА ЗЕРО ЛИМЕНКА 0.33Л" },
    ]);
  const { refreshBrowser } =
    await import("@/nextsignal/services/catalog-browser");
  await refreshBrowser();
  const { indexLocalProducts } =
    await import("@/nextsignal/services/local-matching");
  await indexLocalProducts();
  const { matchBatch } = await import("@/nextsignal/services/matching");
  const fetchMock = vi
    .fn()
    .mockRejectedValue(new Error("Paid calls forbidden"));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const match = await createRun("match", null, null, null);
    expect((await matchBatch(match.id, null)).matched).toBe(1);
    const listings = (
      await pool.query(
        "SELECT product_id,matched_hash,identity_hash FROM listings",
      )
    ).rows;
    expect(new Set(listings.map((listing) => listing.product_id)).size).toBe(1);
    expect(
      listings.every(
        (listing) => listing.matched_hash === listing.identity_hash,
      ),
    ).toBe(true);
    expect(
      (await pool.query("SELECT method FROM match_decisions")).rows[0].method,
    ).toBe("local-rules");
    expect((await matchBatch(match.id, null)).processed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
it("stops the broad AI pass when its request allowance is exhausted", async () => {
  const run = await catalog();
  await stage(run, [row("unknown", "65.00")]);
  const match = await createRun("match", "spar", run.source_id, run.id);
  const enabled = settings.matching.ai.enabled;
  const requests = settings.matching.ai.max_requests_per_run;
  settings.matching.ai.enabled = true;
  settings.matching.ai.max_requests_per_run = 1;
  await pool.query(
    "INSERT INTO ai_usage(run_id,endpoint,model,status,input_tokens,output_tokens,cost_usd) VALUES($1,'responses','test','success',1,0,0)",
    [match.id],
  );
  const fetchMock = vi
    .fn()
    .mockRejectedValue(new Error("Paid request forbidden"));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const { matchBatch } = await import("@/nextsignal/services/matching");
    expect(await matchBatch(match.id, run.source_id)).toMatchObject({
      processed: 0,
      more: false,
      ai_budget_limited: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    settings.matching.ai.enabled = enabled;
    settings.matching.ai.max_requests_per_run = requests;
    vi.unstubAllGlobals();
  }
});

it("browses universal groups without duplicating branches and keeps every connected store when filtered", async () => {
  const spar = await catalog();
  await stage(spar, [
    { ...row("cola", "49.00"), name: "Cola Alpha 330ml" },
    { ...row("milk", "70.00"), name: "Milk Bravo 1L" },
  ]);
  const parent = await createRun("discover", "kam", null, null);
  await saveDiscovery(
    parent,
    ["one", "two"].map((id) => ({
      retailer: "kam" as const,
      external_id: id,
      name: id,
      url: `https://kam.com.mk/${id}`,
      scope: "branch" as const,
      meta: {},
    })),
  );
  const runs = (
    await pool.query<Run>(
      "SELECT * FROM runs WHERE retailer='kam' AND kind='catalog' ORDER BY source_id",
    )
  ).rows;
  for (const [index, run] of runs.entries())
    await stage(run, [
      {
        ...row("cola", index === 0 ? "55.00" : "59.00"),
        name: "Soda Charlie 330ml",
      },
    ]);
  const seed = (
    await pool.query(
      "SELECT id,product_id,identity_hash FROM listings WHERE retailer='spar' AND name='Cola Alpha 330ml'",
    )
  ).rows[0];
  const candidate = (
    await pool.query("SELECT id FROM listings WHERE retailer='kam' LIMIT 1")
  ).rows[0];
  await pool.query(
    "UPDATE listings SET product_id=$1,match_status='matched' WHERE name IN ('Cola Alpha 330ml','Soda Charlie 330ml')",
    [seed.product_id],
  );
  await pool.query(
    "INSERT INTO match_decisions(listing_id,identity_hash,product_id,method,probability,evidence,prompt_version) VALUES($1,$2,$3,'local-rules',1,$4,'test')",
    [
      seed.id,
      seed.identity_hash,
      seed.product_id,
      {
        candidates: [
          { candidate: candidate.id, method: "local-rules", probability: 1 },
        ],
        deferred: false,
      },
    ],
  );
  const { refreshBrowser } =
    await import("@/nextsignal/services/catalog-browser");
  await refreshBrowser();
  const { readDashboard, detailsForProduct } =
    await import("@/nextsignal/services/operations");
  const query = { view: "universal" as const, search: "", page: 1, size: 1 };
  const all = await readDashboard(query);
  expect(all).toMatchObject({
    view: "universal",
    total: 2,
    total_pages: 2,
    page: 1,
  });
  const matched = await readDashboard({
    ...query,
    search: "Alpha",
    retailer: "kam",
    match_filter: "matched",
  });
  if (!("rows" in matched)) throw new Error("Expected product page");
  expect(matched).toMatchObject({ total: 1 });
  expect(matched.rows[0]).toMatchObject({
    product_id: seed.product_id,
    retailers: ["kam", "spar"],
    connected_retailers: 2,
    listing_count: 2,
    price: "49.00",
    highest_price: "59.00",
  });
  expect(
    await readDashboard({ ...query, match_filter: "unmatched" }),
  ).toMatchObject({ total: 1 });
  const detail = await detailsForProduct(seed.product_id);
  expect(detail?.listings).toHaveLength(2);
  expect(detail?.offers).toHaveLength(3);
  expect(detail?.decisions[0]).toMatchObject({
    current_identity: true,
    candidates: [
      { candidate_name: "Soda Charlie 330ml", candidate_retailer: "kam" },
    ],
  });
  expect(await detailsForProduct(randomUUID())).toBeNull();
  const scoped = await readDashboard({
    view: "products",
    source_id: runs[1].source_id!,
    search: "",
    page: 1,
    size: 30,
  });
  expect(scoped).toMatchObject({ total: 1 });
  if (!("rows" in scoped)) throw new Error("Expected catalog products");
  expect(scoped.rows[0]).toMatchObject({
    retailer: "kam",
    price: "59.00",
    highest_price: "59.00",
    catalog_name: (
      await pool.query("SELECT name FROM sources WHERE id=$1", [
        runs[1].source_id,
      ])
    ).rows[0].name,
  });
  const former = (
    await pool.query(
      "INSERT INTO products(name,normalized_name,attributes,redirect_id) VALUES('Former identity','former identity','{}',$1) RETURNING id",
      [seed.product_id],
    )
  ).rows[0];
  expect((await detailsForProduct(former.id))?.product.id).toBe(
    seed.product_id,
  );
});

it("filters data updates by kind and status and excludes inactive catalogs", async () => {
  const run = await catalog();
  await pool.query("UPDATE runs SET status='failed' WHERE id=$1", [run.id]);
  const { readDashboard } = await import("@/nextsignal/services/operations");
  expect(
    await readDashboard({
      view: "runs",
      search: "",
      page: 1,
      size: 30,
      kind: "catalog",
      status: "failed",
    }),
  ).toMatchObject({ total: 1 });
  expect(
    await readDashboard({
      view: "runs",
      search: "",
      page: 1,
      size: 30,
      kind: "match",
      status: "failed",
    }),
  ).toMatchObject({ total: 0 });
  await pool.query("UPDATE sources SET active=false WHERE id=$1", [
    run.source_id,
  ]);
  expect(
    await readDashboard({ view: "sources", search: "", page: 1, size: 30 }),
  ).toMatchObject({ total: 0 });
});

it("reindexes legacy source names idempotently without changing source identity, prices, or saved matches", async () => {
  const run = await catalog();
  const name = "MILKA LE[NIK @ITO }ESE 100G";
  await stage(run, [{ ...row("legacy", "65.00"), name }]);
  const { normalizeName } = await import("@/nextsignal/domain/normalize");
  const { refreshBrowser } =
    await import("@/nextsignal/services/catalog-browser");
  const { reindexProductNames } =
    await import("@/nextsignal/services/name-index");
  const { readDashboard } = await import("@/nextsignal/services/operations");
  const { indexLocalProducts } =
    await import("@/nextsignal/services/local-matching");
  const { localMatchingVersion } =
    await import("@/nextsignal/domain/local-matching");
  await pool.query(
    "UPDATE listings SET normalized_name='milka leshnik ito gjese 100g'",
  );
  await pool.query(
    "UPDATE products SET normalized_name='milka leshnik ito gjese 100g'",
  );
  await refreshBrowser();
  const listingBefore = (await pool.query("SELECT * FROM listings")).rows[0];
  const offersBefore = (await pool.query("SELECT * FROM offers")).rows;
  const result = await reindexProductNames();
  expect(result).toMatchObject({
    names: 1,
    completed: 1,
    listings: 1,
    products: 1,
  });
  const listingAfter = (await pool.query("SELECT * FROM listings")).rows[0];
  expect({
    ...listingAfter,
    normalized_name: listingBefore.normalized_name,
  }).toEqual(listingBefore);
  expect(listingAfter.normalized_name).toBe(
    normalizeName("MILKA ЛЕШНИК ЖИТО ЌЕСЕ 100Г"),
  );
  expect((await pool.query("SELECT * FROM offers")).rows).toEqual(offersBefore);
  expect(
    (await pool.query("SELECT normalized_name FROM products")).rows[0]
      .normalized_name,
  ).toBe(listingAfter.normalized_name);
  await refreshBrowser();
  expect(await reindexProductNames()).toMatchObject({
    names: 0,
    listings: 0,
    products: 0,
  });
  for (const search of ["ЖИТО ЌЕСЕ", "@ITO }ESE", "zhito kjese"]) {
    const page = await readDashboard({
      view: "products",
      search,
      page: 1,
      size: 30,
    });
    expect(page).toMatchObject({ total: 1 });
    if (!("rows" in page)) throw new Error("Expected product page");
    expect(page.rows[0].name).toBe(name);
  }
  expect(await indexLocalProducts()).toBe(1);
  expect(
    (await pool.query("SELECT version,rule_key FROM local_product_keys"))
      .rows[0],
  ).toMatchObject({ version: localMatchingVersion(settings.matching.local) });
});
