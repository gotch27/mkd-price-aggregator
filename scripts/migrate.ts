import { readFile, readdir } from "node:fs/promises";
import { pool, transaction } from "@/nextsignal/services/database";
try {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await transaction(async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtext('catalog-migrations'))",
      );
      if (
        (await c.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]))
          .rowCount
      )
        return;
      await c.query(await readFile(`migrations/${name}`, "utf8"));
      await c.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      console.info(`Applied ${name}`);
    });
} finally {
  await pool.end();
}
