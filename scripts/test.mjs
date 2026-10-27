import nextEnv from "@next/env";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
nextEnv.loadEnvConfig(process.cwd());
const config = JSON.parse(await readFile("config/testing.json", "utf8"));
if (!/^[a-z][a-z0-9_]+$/.test(config.database_name))
  throw new Error("Invalid testing database name");
const url = new URL(process.env.NEXTSIGNAL_DATABASE__URL);
if (url.pathname === `/${config.database_name}`)
  throw new Error(
    "Point the launcher at the application database, not the test database",
  );
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
if (
  !(
    await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
      config.database_name,
    ])
  ).rowCount
)
  await admin.query(`CREATE DATABASE "${config.database_name}"`);
await admin.end();
url.pathname = `/${config.database_name}`;
const env = {
  ...process.env,
  NEXTSIGNAL_DATABASE__URL: url.href,
  NEXTSIGNAL_MATCHING__AI__ENABLED: String(config.ai_enabled),
  NEXTSIGNAL_MATCHING__GATEWAY__ENABLED: "false",
  NEXTSIGNAL_MATCHING__GATEWAY__API_KEY: "isolated-test-key",
  NEXTSIGNAL_MATCHING__AUTOMATIC_ENABLED: "false",
  NEXTSIGNAL_LOGGING__SPOOL_DIR: config.log_spool_dir,
};
const migration = spawnSync("npm", ["run", "migrate"], {
  env,
  stdio: "inherit",
});
if (migration.status !== 0) process.exit(migration.status ?? 1);
const result = spawnSync("npx", ["vitest", "run", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
