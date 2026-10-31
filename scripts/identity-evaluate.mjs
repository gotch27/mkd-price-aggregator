import nextEnv from "@next/env";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
nextEnv.loadEnvConfig(process.cwd());
const testing = JSON.parse(await readFile("config/testing.json", "utf8"));
if (!/^[a-z][a-z0-9_]+_matching_test$/.test(testing.identity_database_name))
  throw new Error("Dedicated identity evaluation database required");
const url = new URL(process.env.NEXTSIGNAL_DATABASE__URL);
if (url.pathname.endsWith("_matching_test"))
  throw new Error(
    "Launch using the application connection, not an evaluation database",
  );
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
if (
  !(
    await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
      testing.identity_database_name,
    ])
  ).rowCount
)
  await admin.query(`CREATE DATABASE "${testing.identity_database_name}"`);
await admin.end();
url.pathname = `/${testing.identity_database_name}`;
const paid = process.argv.includes("--paid");
const env = {
  ...process.env,
  NEXTSIGNAL_DATABASE__URL: url.href,
  NEXTSIGNAL_MATCHING__GATEWAY__ENABLED: String(paid),
};
const migration = spawnSync("npm", ["run", "migrate"], {
  env,
  stdio: "inherit",
});
if (migration.status !== 0) process.exit(migration.status ?? 1);
const result = spawnSync(
  "npx",
  ["tsx", "scripts/identity-evaluate.ts", ...process.argv.slice(2)],
  { env, stdio: "inherit" },
);
process.exit(result.status ?? 1);
