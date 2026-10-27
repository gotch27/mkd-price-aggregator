import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import {
  seedRetailers,
  stagePage,
  publishCatalog,
} from "@/nextsignal/services/catalog-repository";
import { createRun, getRun } from "@/nextsignal/services/run-repository";
import { search, save } from "@/nextsignal/services/manual-matching";
import { GET } from "@/app/api/products/[id]/matching/route";
import { sessionToken, SESSION_COOKIE } from "@/nextsignal/adapters/auth";
import {
  findCandidates,
  getProduct,
  groupMembers,
  manuallySeparatedCandidates,
  recordResult,
  ensureCampaign,
  claimWork,
} from "@/nextsignal/services/matching-repository";
import type { Retailer, CatalogRow } from "@/nextsignal/domain/types";
import type { ManualGroup } from "@/nextsignal/domain/manual-matching";
import {
  pairKey,
  manualLinks,
} from "@/nextsignal/services/manual-match-memory";
const original = structuredClone(settings.matching);
beforeEach(async () => {
  if (!new URL(settings.database.url).pathname.endsWith("_test"))
    throw new Error("Isolated test database required");
  vi.restoreAllMocks();
  Object.assign(settings.matching, structuredClone(original));
  await pool.query("TRUNCATE retailers,products,runs,sources,listings CASCADE");
  await seedRetailers();
});
afterAll(async () => {
  Object.assign(settings.matching, original);
  vi.restoreAllMocks();
  await pool.end();
});
async function publish(
  retailer: Retailer,
  key: string,
  name = "Example chocolate 100 g",
  price = "40.00",
  branch = "one",
  empty = false,
) {
  const source = (
    await pool.query(
      `INSERT INTO sources(retailer,external_id,name,url,scope,meta) VALUES($1,$2,$2,$3,'branch','{}') ON CONFLICT(retailer,external_id) DO UPDATE SET active=true RETURNING id`,
      [retailer, branch, settings.sources[retailer].url],
    )
  ).rows[0].id;
  const run = await createRun("catalog", retailer, source, null);
  const row: CatalogRow = {
    key,
    name,
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
  };
  await stagePage(run, {
    rows: empty ? [] : [row],
    next: null,
    total: empty ? 0 : 1,
    artifact: null,
  });
  await publishCatalog(await getRun(run.id));
  return (
    await pool.query(
      "SELECT * FROM store_products WHERE retailer=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
      [retailer],
    )
  ).rows[0];
}
async function group(id: string) {
  return (await search(id, "", 1)).group!;
}
async function connect(a: ManualGroup, b: ManualGroup) {
  return save(
    {
      id: a.id,
      action: "connect",
      snapshot: a.snapshot,
      candidate_id: b.id,
      candidate_snapshot: b.snapshot,
      note: "Verified packaging",
    },
    "test-admin",
  );
}

it("saves manual connections across imports, branch copies, absence and return without AI", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No AI expected"));
  const a = await publish("kam", "a"),
    b = await publish("vero", "b");
  expect((await group(a.group_id)).members).toHaveLength(1);
  expect(
    await connect(await group(a.group_id), await group(b.group_id)),
  ).toEqual({ ok: true, product_id: a.group_id });
  await publish("kam", "a", undefined, "45.00");
  await publish("kam", "a", undefined, "46.00", "two");
  await publish("vero", "b", undefined, "40.00", "one", true);
  await publish("vero", "b", undefined, "48.00");
  expect((await getProduct(b.id)).group_id).toBe(a.group_id);
  expect((await group(a.group_id)).members).toHaveLength(2);
  expect(
    (await pool.query("SELECT action FROM manual_product_links")).rows,
  ).toEqual([{ action: "same" }]);
  expect(
    (
      await pool.query(
        "SELECT * FROM product_membership_history WHERE decision_id IS NOT NULL",
      )
    ).rowCount,
  ).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});
it("separates a wrong match, remembers the difference, and allows deliberate reconnection", async () => {
  const a = await publish("kam", "a"),
    b = await publish("vero", "b"),
    c = await publish("spar", "c");
  await connect(await group(a.group_id), await group(b.group_id));
  await connect(await group(a.group_id), await group(c.group_id));
  const g = await group(a.group_id);
  expect(
    (
      await save(
        {
          id: g.id,
          action: "separate",
          snapshot: g.snapshot,
          member_id: b.id,
          note: "Wrong variant",
        },
        "admin",
      )
    ).ok,
  ).toBe(true);
  expect((await group(g.id)).members).toHaveLength(2);
  const removed = await getProduct(b.id);
  expect(removed.group_id).not.toBe(g.id);
  const candidates = await findCandidates(removed);
  expect(
    (await manuallySeparatedCandidates(removed, candidates)).has(g.id),
  ).toBe(true);
  const links = await pool.connect();
  try {
    const memory = await manualLinks(links, [a.id, b.id, c.id]);
    expect(memory.get(pairKey(a.id, b.id))).toBe("different");
    expect(memory.get(pairKey(b.id, c.id))).toBe("different");
  } finally {
    links.release();
  }
  await connect(await group(g.id), await group(removed.group_id));
  expect((await group(g.id)).members).toHaveLength(3);
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM manual_product_links"))
      .rows[0].n,
  ).toBe(7);
});
it("rejects changed snapshots, different sizes and same-store group collisions atomically", async () => {
  const a = await publish("kam", "a"),
    b = await publish("vero", "b"),
    c = await publish("kam", "c", undefined, "40.00", "two"),
    d = await publish("spar", "d", "Example chocolate 200 g");
  const old = await group(a.group_id);
  expect((await connect(old, await group(c.group_id))).ok).toBe(false);
  expect((await connect(old, await group(d.group_id))).ok).toBe(false);
  await connect(old, await group(b.group_id));
  expect((await connect(old, await group(d.group_id))).ok).toBe(false);
  expect((await group(a.group_id)).members).toHaveLength(2);
  expect(
    (await pool.query("SELECT * FROM manual_product_links")).rowCount,
  ).toBe(1);
});
it("indexes only selected legacy identities and their branch copies on demand", async () => {
  const a = await publish("kam", "a"),
    b = await publish("vero", "b");
  await publish("kam", "a", undefined, "41.00", "two");
  await publish("spar", "unrelated");
  await pool.query("TRUNCATE store_products CASCADE");
  await pool.query("REFRESH MATERIALIZED VIEW catalog_browser");
  const legacyId = (
    await pool.query(
      "SELECT l.product_id FROM catalog_browser b JOIN listings l ON l.id=b.listing_id WHERE b.retailer='kam'",
    )
  ).rows[0].product_id;
  const before = await group(legacyId);
  expect(before.members[0].indexed).toBe(false);
  expect((await pool.query("SELECT * FROM store_products")).rowCount).toBe(0);
  expect((await connect(before, await group(b.group_id))).ok).toBe(true);
  expect((await pool.query("SELECT * FROM store_products")).rowCount).toBe(2);
  expect(
    (await pool.query("SELECT * FROM store_product_aliases")).rowCount,
  ).toBe(3);
  expect((await group(legacyId)).members).toHaveLength(2);
});
it("new meaningful source revisions must earn their own match", async () => {
  const a = await publish("kam", "a"),
    b = await publish("vero", "b");
  await connect(await group(a.group_id), await group(b.group_id));
  const changed = await publish("vero", "b", "Example chocolate 200 g");
  expect(changed.id).not.toBe(b.id);
  expect(changed.group_id).not.toBe(a.group_id);
  expect((await getProduct(b.id)).group_id).toBe(a.group_id);
});

it("keeps human corrections authoritative over old branch matching fields", async () => {
  const a = await publish("kam", "a"),
    b = await publish("vero", "b");
  await connect(await group(a.group_id), await group(b.group_id));
  await pool.query(
    "UPDATE listings SET product_id=$1,match_status='matched' WHERE retailer='vero'",
    [a.group_id],
  );
  const g = await group(a.group_id);
  await save(
    {
      id: g.id,
      action: "separate",
      snapshot: g.snapshot,
      member_id: b.id,
      note: "Correction",
    },
    "admin",
  );
  const separate = (await getProduct(b.id)).group_id;
  await publish("vero", "b", undefined, "51.00");
  expect((await getProduct(b.id)).group_id).toBe(separate);
  expect((await getProduct(b.id)).state).not.toBe("legacy_conflict");
  expect(
    (
      await pool.query("SELECT matching_conflict FROM products WHERE id=$1", [
        separate,
      ])
    ).rows[0].matching_conflict,
  ).toBe(false);
});
it("an in-flight automatic answer cannot undo a manual separation", async () => {
  const a = await publish("kam", "a"),
    b = await publish("vero", "b");
  const campaign = await ensureCampaign("evaluation");
  await pool.query("UPDATE matching_work SET campaign_id=$1", [campaign.id]);
  const work = (await claimWork(campaign.id))[0];
  const query = await getProduct(work.store_product_id);
  const candidates = await findCandidates(query);
  await connect(await group(a.group_id), await group(b.group_id));
  const g = await group(a.group_id);
  await save(
    {
      id: g.id,
      action: "separate",
      snapshot: g.snapshot,
      member_id: b.id,
      note: "Different products",
    },
    "admin",
  );
  const result = await recordResult(
    query,
    work,
    candidates.map((candidate) => ({
      candidate,
      outcome: "matched" as const,
      method: "rules" as const,
      reason: "old answer",
      probability: 1,
      confidence: null,
    })),
    "old-answer",
    "No other counterpart",
  );
  expect(result.matched).toBe(false);
  expect((await getProduct(a.id)).group_id).not.toBe(
    (await getProduct(b.id)).group_id,
  );
});

it("pages all eligible groups with stable ordering, exact totals and store filtering", async () => {
  const provider = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Search must not call AI"));
  const anchor = await publish("kam", "anchor", "Paging anchor 100 g");
  const expected: string[] = [];
  const vero: string[] = [];
  for (let i = 1; i <= 13; i++) {
    const chain = i % 2 ? "vero" : "spar";
    const p = await publish(
      chain,
      `candidate-${i}`,
      `Paging candidate ${String(i).padStart(2, "0")} 100 g`,
      "40.00",
      `branch-${i}`,
    );
    expected.push(p.group_id);
    if (chain === "vero") vero.push(p.group_id);
  }
  // This group contains KAM even though only its Vero label matches the search.
  // It must be excluded BEFORE pagination and counting, including on later pages.
  const blocked = await publish(
    "kam",
    "blocked",
    "Another label 100 g",
    "40.00",
    "blocked",
  );
  const partner = await publish(
    "vero",
    "blocked-partner",
    "Paging candidate 99 100 g",
    "40.00",
    "blocked-partner",
  );
  expect(
    (
      await connect(
        await group(blocked.group_id),
        await group(partner.group_id),
      )
    ).ok,
  ).toBe(true);
  const before = await pool.query(
    "SELECT count(*)::int AS n FROM manual_product_links",
  );
  const pages = [];
  for (let page = 1; page <= 3; page++)
    pages.push(await search(anchor.group_id, "Paging candidate", page));
  expect(pages.map((p) => p.candidates.length)).toEqual([5, 5, 3]);
  expect(
    pages.map((p) => [p.page, p.page_size, p.total, p.total_pages]),
  ).toEqual([
    [1, 5, 13, 3],
    [2, 5, 13, 3],
    [3, 5, 13, 3],
  ]);
  expect(pages.flatMap((p) => p.candidates.map((g) => g.id))).toEqual(expected);
  expect(
    (await search(anchor.group_id, "Paging candidate", 2)).candidates.map(
      (g) => g.id,
    ),
  ).toEqual(expected.slice(5, 10));
  const filtered = await search(anchor.group_id, "Paging candidate", 2, "vero");
  expect(filtered).toMatchObject({ page: 2, total: 7, total_pages: 2 });
  expect(filtered.candidates.map((g) => g.id)).toEqual(vero.slice(5));
  const last = await search(anchor.group_id, "Paging candidate", 999999);
  expect(last.page).toBe(3);
  expect(last.candidates.map((g) => g.id)).toEqual(expected.slice(10));
  expect(await search(anchor.group_id, "No such product", 4)).toMatchObject({
    candidates: [],
    page: 1,
    total: 0,
    total_pages: 0,
  });
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM manual_product_links"))
      .rows,
  ).toEqual(before.rows);
  expect(provider).not.toHaveBeenCalled();
});

it("validates page input on the authenticated manual search endpoint", async () => {
  const anchor = await publish("kam", "anchor");
  const cookie = `${SESSION_COOKIE}=${sessionToken()}`;
  const context = { params: Promise.resolve({ id: anchor.group_id }) };
  for (const page of ["0", "-1", "1.5", "word", "999999999999999999999"]) {
    const response = await GET(
      new Request(
        `http://localhost:3000/api/products/${anchor.group_id}/matching?search=Example&page=${page}`,
        { headers: { cookie } },
      ),
      context,
    );
    expect(response.status).toBe(400);
  }
  const url = `http://localhost:3000/api/products/${anchor.group_id}/matching?search=Example&page=1`;
  expect((await GET(new Request(url), context)).status).toBe(401);
  const valid = await GET(new Request(url, { headers: { cookie } }), context);
  expect(valid.status).toBe(200);
  expect((await valid.json()).data).toMatchObject({
    page: 1,
    page_size: 5,
    total: 0,
    total_pages: 0,
  });
});

it("finds whole product words across scripts without matching longer unrelated words", async () => {
  const provider = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Search must not call AI"));
  const anchor = await publish("zito", "anchor", "КАНТА ЗА ЃУБРЕ 45л");
  const bucket = await publish("kam", "bucket", "КАНТА ЗА ОТПАД 45л");
  const cheese = await publish("vero", "cheese", "СИРЕЊЕ ВО КАНТА 500г");
  await publish("spar", "tea", "^AJ KANTARION ALKALOID");
  await publish("ramstore", "spicy", "ПИКАНТА САЛАТА 200г");
  for (const term of ["kanta", "КАНТА"]) {
    const result = await search(anchor.group_id, term, 1);
    expect(result.total).toBe(2);
    expect(result.candidates.map((g) => g.id).sort()).toEqual(
      [bucket.group_id, cheese.group_id].sort(),
    );
    expect(result.candidates.every((g) => g.members.length > 0)).toBe(true);
  }
  const drink = await publish("spar", "drink", "Coca-Cola Original 330 ml");
  const aliases = await search(anchor.group_id, "кока кола", 1);
  expect(aliases.candidates.map((g) => g.id)).toEqual([drink.group_id]);
  const decimal = await publish("ramstore", "decimal", "Milk 1.5% 1 l");
  await publish("vero", "other-decimal", "Milk 115% 1 l", "40.00", "other");
  expect(
    (await search(anchor.group_id, "1.5%", 1)).candidates.map((g) => g.id),
  ).toEqual([decimal.group_id]);
  expect(provider).not.toHaveBeenCalled();
});
