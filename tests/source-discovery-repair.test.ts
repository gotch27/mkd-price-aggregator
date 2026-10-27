import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import { readSettings } from "@/nextsignal/services/task-settings";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import {
  fetchSourceDiscoveryRepairPages,
  repairSourceDiscovery,
  type DiscoveryRepairPages,
} from "@/nextsignal/services/source-discovery-repair";
import type { CatalogRow } from "@/nextsignal/domain/types";

const pages: DiscoveryRepairPages = {
  vero: '<table><tr><td><a href="89_1.html"><h1>ВЕРО 1</h1></a></td><td><a href="119_1.html"><h1>ЏАМБО 2</a></h1></td><td><a href="168_1.html"><h1>ЏАМБО 3</a></h1></td></tr></table>',
  ramstore:
    '<div class="store"><h2>РАМСТОРЕ АЕРОДРОМ</h2><button onclick="location.href=\'https://ramstore.com.mk/marketi/ramstore-aerodrom/\';">Prices</button></div>',
  spar: '<article><h3>SPAR M.12 Ko~ani</h3><div class="Markets__location">Kocani</div><a href="/pricelist/10">Prices</a></article>',
};
const actor = "tester";
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated database required");
  await pool.query(
    "TRUNCATE retailers,sources,runs,products,listings,operational_settings,operational_settings_history,task_executions,worker_heartbeats,host_limits,logs CASCADE",
  );
  await seedRetailers();
  await readSettings();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected external request");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => pool.end());
async function source(
  retailer: "vero" | "spar" | "ramstore",
  external: string,
  name: string,
  meta: Record<string, unknown> = {},
) {
  return (
    await pool.query(
      "INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,$3,$4,'branch',$5) RETURNING *",
      [retailer, external, name, settings.sources[retailer].url, meta],
    )
  ).rows[0];
}
async function savedPrices(id: string) {
  const r = await createRun("catalog", "vero", id, null);
  const row: CatalogRow = {
    key: "same",
    name: "Milk 1L",
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
  await stagePage(r, { rows: [row], next: null, total: 1, artifact: null });
  await publishCatalog(await getRun(r.id));
  return r;
}
async function priceAndMatchingMemory() {
  const snapshot: Record<string, unknown> = {};
  for (const table of [
    "offers",
    "listings",
    "products",
    "store_products",
    "product_membership_history",
    "matching_work",
  ])
    snapshot[table] = (
      await pool.query(`SELECT * FROM ${table} ORDER BY 1`)
    ).rows;
  return snapshot;
}

it("previews only existing metadata changes without touching sources, runs, or locations", async () => {
  await source("vero", "89", "ВЕРО 1", { keep: "custom" });
  await source("vero", "119", "");
  const unknown = await source("vero", "999", "Unknown old catalog", {
    keep: "unchanged",
  });
  await source(
    "ramstore",
    "/marketi/ramstore-aerodrom/",
    "/marketi/ramstore-aerodrom/",
    { keep: "custom" },
  );
  await source("spar", "10", "10SPAR M.12 Ko~ani KocaniPrices");
  await pool.query(
    "INSERT INTO worker_heartbeats(key,seen_at) VALUES('catalog',now())",
  );
  const before = (await pool.query("SELECT * FROM sources ORDER BY id")).rows;
  const result = await repairSourceDiscovery({ pages, apply: false, actor });
  expect(result).toMatchObject({
    applied: false,
    reviewed_sources: 5,
    changed_sources: 4,
    deactivated_sources: 1,
  });
  expect((await pool.query("SELECT * FROM sources ORDER BY id")).rows).toEqual(
    before,
  );
  expect(result.changes.find((c) => c.external_id === "999")).toBeUndefined();
  expect(
    result.changes.find((c) => c.retailer === "ramstore")?.after.meta.keep,
  ).toBe("custom");
  expect((await pool.query("SELECT id FROM runs")).rowCount).toBe(0);
  expect(
    (await pool.query("SELECT id FROM sources WHERE external_id='168'"))
      .rowCount,
  ).toBe(0);
  expect(
    (await pool.query("SELECT name FROM sources WHERE id=$1", [unknown.id]))
      .rows[0].name,
  ).toBe("Unknown old catalog");
  expect(fetch).not.toHaveBeenCalled();
});

it("corrects names, excludes proven Jumbo, skips only unfinished catalog runs, and preserves all price/matching memory", async () => {
  const jumbo = await source("vero", "119", "", { keep: "custom" });
  const published = await savedPrices(jumbo.id);
  const pending = await createRun("catalog", "vero", jumbo.id, null);
  const paused = await createRun("catalog", "vero", jumbo.id, null);
  await pool.query("UPDATE runs SET status='paused' WHERE id=$1", [paused.id]);
  await source("spar", "10", "SPAR unclean");
  const memory = await priceAndMatchingMemory();
  const beforeIds = (await pool.query("SELECT id FROM sources ORDER BY id"))
    .rows;
  const result = await repairSourceDiscovery({ pages, apply: true, actor });
  expect(result).toMatchObject({
    changed_sources: 2,
    deactivated_sources: 1,
    skipped_catalog_runs: 2,
  });
  const corrected = (
    await pool.query("SELECT * FROM sources WHERE id=$1", [jumbo.id])
  ).rows[0];
  expect(corrected).toMatchObject({
    name: "ЏАМБО 2",
    active: false,
    meta: {
      keep: "custom",
      outlet_type: "excluded_non_supermarket",
      discovery_name_history: [{ name: "", actor }],
    },
  });
  expect((await getRun(published.id)).status).toBe("success");
  expect((await getRun(pending.id)).status).toBe("superseded");
  expect((await getRun(paused.id)).status).toBe("superseded");
  expect(await priceAndMatchingMemory()).toEqual(memory);
  expect((await pool.query("SELECT id FROM sources ORDER BY id")).rows).toEqual(
    beforeIds,
  );
  const audit = (
    await pool.query(
      "SELECT data FROM logs WHERE data->>'event'='catalog.discovery.repaired' AND source_id=$1",
      [jumbo.id],
    )
  ).rows[0].data;
  expect(audit.before.name).toBe("");
  expect(audit.after.name).toBe("ЏАМБО 2");
  expect(audit.skipped_run_ids).toHaveLength(2);
  const second = await repairSourceDiscovery({ pages, apply: true, actor });
  expect(second.changed_sources).toBe(0);
  expect(second.skipped_catalog_runs).toBe(0);
  expect(
    (await pool.query("SELECT meta FROM sources WHERE id=$1", [jumbo.id]))
      .rows[0].meta.discovery_name_history,
  ).toHaveLength(1);
});

it("allows a globally paused online worker after all import reservations have cleared", async () => {
  await source("spar", "10", "Old SPAR name");
  await pool.query(
    "INSERT INTO worker_heartbeats(key,seen_at) VALUES('catalog',now())",
  );
  await expect(
    repairSourceDiscovery({ pages, apply: true, actor }),
  ).rejects.toThrow("Pause all work");
  await pool.query(
    "UPDATE operational_settings SET policy=jsonb_set(policy,'{paused}','true')",
  );
  expect(
    (await repairSourceDiscovery({ pages, apply: true, actor }))
      .changed_sources,
  ).toBe(1);
});

it.each(["running", "queued"] as const)(
  "rejects apply with a %s import, even while globally paused",
  async (status) => {
    const s = await source("vero", "119", "");
    const run = await createRun("catalog", "vero", s.id, null);
    await pool.query(
      "UPDATE operational_settings SET policy=jsonb_set(policy,'{paused}','true')",
    );
    await pool.query(
      "UPDATE runs SET status=$2,dispatch_token=$3 WHERE id=$1",
      [run.id, status, status === "queued" ? randomUUID() : null],
    );
    await expect(
      repairSourceDiscovery({ pages, apply: true, actor }),
    ).rejects.toThrow("executing imports and dispatch reservations");
    expect(
      (await pool.query("SELECT active FROM sources WHERE id=$1", [s.id]))
        .rows[0].active,
    ).toBe(true);
  },
);

it("rolls back the whole correction before emitting success audit when metadata history is malformed", async () => {
  const first = await source(
    "ramstore",
    "/marketi/ramstore-aerodrom/",
    "Old Ramstore name",
  );
  await source("spar", "10", "Old SPAR name", {
    discovery_name_history: "do not overwrite",
  });
  await expect(
    repairSourceDiscovery({ pages, apply: true, actor }),
  ).rejects.toThrow("Invalid discovery name history");
  expect(
    (await pool.query("SELECT name FROM sources WHERE id=$1", [first.id]))
      .rows[0].name,
  ).toBe("Old Ramstore name");
  expect(
    (
      await pool.query(
        "SELECT id FROM logs WHERE data->>'event'='catalog.discovery.repaired'",
      )
    ).rowCount,
  ).toBe(0);
});

it("does not reactivate an otherwise valid source as part of a metadata-only repair", async () => {
  const s = await source("spar", "10", "Old SPAR name");
  await pool.query("UPDATE sources SET active=false WHERE id=$1", [s.id]);
  await repairSourceDiscovery({ pages, apply: true, actor });
  expect(
    (await pool.query("SELECT active,name FROM sources WHERE id=$1", [s.id]))
      .rows[0],
  ).toMatchObject({ active: false, name: "SPAR M.12 Kočani" });
});

it("refuses an unrecognized publisher layout instead of deactivating unlisted sources", async () => {
  const s = await source("vero", "119", "");
  await expect(
    repairSourceDiscovery({
      pages: { ...pages, vero: "<p>temporarily unavailable</p>" },
      apply: true,
      actor,
    }),
  ).rejects.toThrow("No verified vero store cards");
  expect(
    (await pool.query("SELECT active FROM sources WHERE id=$1", [s.id])).rows[0]
      .active,
  ).toBe(true);
});

it("fetches exactly the three public listing pages without creating runs or writing host-health state", async () => {
  vi.mocked(fetch).mockImplementation(
    async (url) =>
      new Response(
        pages[
          (["vero", "ramstore", "spar"] as const).find(
            (retailer) => settings.sources[retailer].url === String(url),
          )!
        ],
      ),
  );
  expect(await fetchSourceDiscoveryRepairPages()).toEqual(pages);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect((await pool.query("SELECT id FROM runs")).rowCount).toBe(0);
  expect((await pool.query("SELECT host FROM host_limits")).rowCount).toBe(0);
});

it("cannot publish a newly staged replacement after its source has been made inactive", async () => {
  const s = await source("vero", "119", "");
  const saved = await savedPrices(s.id);
  const memory = await priceAndMatchingMemory();
  const replacement = await createRun("catalog", "vero", s.id, null);
  const row: CatalogRow = {
    key: "new",
    name: "Other milk 1L",
    description: null,
    category: null,
    gtin: null,
    price: "70.00",
    regular_price: null,
    promo_price: null,
    unit_price: null,
    available: true,
    promotion: null,
    source_updated_at: null,
    raw: {},
  };
  await stagePage(replacement, {
    rows: [row],
    next: null,
    total: 1,
    artifact: null,
  });
  await pool.query("UPDATE sources SET active=false WHERE id=$1", [s.id]);
  expect(await publishCatalog(await getRun(replacement.id))).toMatchObject({
    status: "superseded",
  });
  expect(
    (await pool.query("SELECT published_run FROM sources WHERE id=$1", [s.id]))
      .rows[0].published_run,
  ).toBe(saved.id);
  expect(await priceAndMatchingMemory()).toEqual(memory);
});
