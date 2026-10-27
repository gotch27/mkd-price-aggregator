import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import { seedRetailers } from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import { createTask } from "@/nextsignal/services/tasks";
import {
  readSettings,
  saveSettings,
} from "@/nextsignal/services/task-settings";
import {
  claimPendingRuns,
  releaseDispatch,
} from "@/nextsignal/services/import-dispatch";
import type { Retailer } from "@/nextsignal/domain/types";

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
      throw new Error("Unexpected external request");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => pool.end());

async function fixture(retailers: Retailer[] = ["spar"], downloads = 1) {
  const saved = await readSettings();
  const policy = await saveSettings(
    saved.revision,
    {
      ...saved.policy,
      parallel_imports: downloads,
      per_store_downloads: downloads,
    },
    "tester",
  );
  const task = await createTask(
    {
      revision: policy.revision,
      kind: "import",
      retailers,
      source_id: null,
      product_limit: null,
      use_ai: false,
      categories: [],
      max_cost_usd: 0,
      recheck: false,
      idempotency_key: randomUUID(),
    },
    "tester",
  );
  await pool.query(
    `UPDATE task_executions SET state='running',checkpoint='{"initialized":true}' WHERE id=$1`,
    [task.id],
  );
  return async (retailer: Retailer = retailers[0]) => {
    const externalId = randomUUID();
    const source = (
      await pool.query<{ id: string }>(
        "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,$2,$3,'branch','{}') RETURNING id",
        [retailer, externalId, settings.sources[retailer].url],
      )
    ).rows[0];
    const run = await createRun("catalog", retailer, source.id, null);
    await pool.query("UPDATE runs SET task_id=$2 WHERE id=$1", [
      run.id,
      task.id,
    ]);
    return run.id;
  };
}

async function savedPartial(id: string, retry = false) {
  await pool.query(
    `UPDATE runs SET attempts=1,checkpoint=checkpoint||'{"pages_saved":25,"cursor":"26","done":false}',
       retry_failures=$2,next_attempt_at=CASE WHEN $2>0 THEN now()-interval '1 second' ELSE NULL END
     WHERE id=$1`,
    [id, retry ? 1 : 0],
  );
}

it("continues a healthy saved snapshot before opening another catalog from the same chain", async () => {
  const add = await fixture();
  const untouched = await add();
  const partial = await add();
  await savedPartial(partial);
  expect((await claimPendingRuns(1))[0].id).toBe(partial);
  expect((await getRun(untouched)).attempts).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("lets a less recently served chain go before a partial catalog's next download turn", async () => {
  const add = await fixture(["spar", "kam"]);
  const partial = await add("spar");
  await savedPartial(partial);
  await pool.query(
    "UPDATE runs SET dispatched_at=now()-interval '1 minute' WHERE id=$1",
    [partial],
  );
  const untouchedOtherChain = await add("kam");
  expect((await claimPendingRuns(1))[0].id).toBe(untouchedOtherChain);
});

it("keeps a failing partial snapshot behind fresh work even when its retry is due", async () => {
  const add = await fixture();
  const retry = await add();
  await savedPartial(retry, true);
  const untouched = await add();
  const claimed = (await claimPendingRuns(1))[0];
  expect(claimed.id).toBe(untouched);
  await pool.query("UPDATE runs SET status='success' WHERE id=$1", [untouched]);
  await releaseDispatch(claimed.id, claimed.dispatch_token);
  expect((await claimPendingRuns(1))[0].id).toBe(retry);
});

it("keeps completed publication ahead of partial download work", async () => {
  const add = await fixture();
  const partial = await add();
  await savedPartial(partial);
  const ready = await add();
  await pool.query(
    `UPDATE runs SET checkpoint=checkpoint||'{"pages_saved":150,"done":true}' WHERE id=$1`,
    [ready],
  );
  expect((await claimPendingRuns(1))[0]).toMatchObject({
    id: ready,
    phase: "publish",
  });
});

it("keeps working on the same bounded set of healthy snapshots across download turns", async () => {
  const add = await fixture(["spar"], 2);
  const ids = [];
  for (let n = 0; n < 6; n++) ids.push(await add());
  const first = await claimPendingRuns(10);
  expect(first).toHaveLength(2);
  for (const run of first) {
    await savedPartial(run.id);
    await pool.query("UPDATE runs SET status='pending' WHERE id=$1", [run.id]);
    await releaseDispatch(run.id, run.dispatch_token);
  }
  const next = await claimPendingRuns(10);
  expect(new Set(next.map((run) => run.id))).toEqual(
    new Set(first.map((run) => run.id)),
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM runs WHERE id=ANY($1::uuid[]) AND attempts=0 AND status='pending'",
        [ids.filter((id) => !first.some((run) => run.id === id))],
      )
    ).rows[0].n,
  ).toBe(4);
});

it("does not give a partial snapshot permission to bypass a store cooldown", async () => {
  const add = await fixture(["spar", "kam"]);
  const partial = await add("spar");
  await savedPartial(partial);
  const host = new URL(settings.sources.spar.url).host;
  await pool.query(
    "INSERT INTO host_limits(host,next_at,consecutive_failures,cooldown_until) VALUES($1,now(),3,now()+interval '5 minutes')",
    [host],
  );
  const other = await add("kam");
  expect((await claimPendingRuns(1))[0].id).toBe(other);
});

it("resolves inactive pending, queued and paused catalogs without consuming a download slot", async () => {
  const add = await fixture();
  const pending = await add();
  const queued = await add();
  const paused = await add();
  const active = await add();
  const ids = [pending, queued, paused];
  await pool.query(
    "UPDATE sources SET active=false WHERE id IN(SELECT source_id FROM runs WHERE id=ANY($1::uuid[]))",
    [ids],
  );
  await pool.query(
    "UPDATE runs SET status='queued',dispatch_token=$2,dispatch_phase='download',dispatch_until=now()+interval '5 minutes' WHERE id=$1",
    [queued, randomUUID()],
  );
  await pool.query("UPDATE runs SET status='paused' WHERE id=$1", [paused]);
  expect((await claimPendingRuns(1))[0].id).toBe(active);
  const retired = (
    await pool.query(
      "SELECT status,dispatch_token,dispatch_phase,summary,finished_at FROM runs WHERE id=ANY($1::uuid[])",
      [ids],
    )
  ).rows;
  expect(retired).toHaveLength(3);
  for (const row of retired) {
    expect(row).toMatchObject({
      status: "superseded",
      dispatch_token: null,
      dispatch_phase: null,
      summary: { reason: "Catalog no longer offered", source_inactive: true },
    });
    expect(row.finished_at).toBeInstanceOf(Date);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["run-delivery", "run", "source"])(
  "does not retire inactive work while its %s lock is held by a handler",
  async (kind) => {
    const add = await fixture();
    const id = await add();
    const run = await getRun(id);
    await pool.query("UPDATE sources SET active=false WHERE id=$1", [
      run.source_id,
    ]);
    const c = await pool.connect();
    const key = `${kind}:${kind === "source" ? run.source_id : id}`;
    try {
      await c.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
      expect(await claimPendingRuns(1)).toEqual([]);
      expect((await getRun(id)).status).toBe("pending");
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
      c.release();
    }
    expect(await claimPendingRuns(1)).toEqual([]);
    expect((await getRun(id)).status).toBe("superseded");
  },
);

it("leaves inactive running handlers to finish their current safe boundary", async () => {
  const add = await fixture();
  const id = await add();
  const run = await getRun(id);
  await pool.query("UPDATE sources SET active=false WHERE id=$1", [
    run.source_id,
  ]);
  await pool.query("UPDATE runs SET status='running' WHERE id=$1", [id]);
  expect(await claimPendingRuns(1)).toEqual([]);
  expect((await getRun(id)).status).toBe("running");
});
