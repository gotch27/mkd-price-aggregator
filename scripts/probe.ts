import { mkdir, writeFile } from "node:fs/promises";
import { settings } from "@/nextsignal/config";
import { discover, retrieve } from "@/nextsignal/services/importers";
import { seedRetailers } from "@/nextsignal/services/catalog-repository";
import { pool } from "@/nextsignal/services/database";
import type { Retailer } from "@/nextsignal/domain/types";
await mkdir("tests/fixtures/live", { recursive: true });
try {
  await seedRetailers();
  for (const retailer of (process.argv.slice(2).length
    ? process.argv.slice(2)
    : Object.keys(settings.sources)) as Retailer[]) {
    try {
      const sources = await discover(retailer);
      const first = sources.find((s) => !s.meta.unavailable);
      if (!first) throw new Error("No available catalog");
      const page = await retrieve(
        { ...first, id: crypto.randomUUID() },
        null,
      ).next();
      if (page.done) throw new Error("No catalog page");
      await writeFile(
        `tests/fixtures/live/${retailer}.json`,
        JSON.stringify(
          {
            captured_at: new Date().toISOString(),
            source: first,
            sources: sources.length,
            total: page.value.total,
            next: page.value.next,
            rows: page.value.rows.slice(0, 12),
          },
          null,
          2,
        ),
      );
      console.info(
        JSON.stringify({
          retailer,
          sources: sources.length,
          rows: page.value.rows.length,
          total: page.value.total,
          next: page.value.next,
          sample: page.value.rows[0]?.name,
        }),
      );
    } catch (error) {
      console.error(retailer, String(error));
      process.exitCode = 1;
    }
  }
} finally {
  await pool.end();
}
