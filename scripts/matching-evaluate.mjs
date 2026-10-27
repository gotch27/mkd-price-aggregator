import nextEnv from "@next/env";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import pg from "pg";
nextEnv.loadEnvConfig(process.cwd());
const testing = JSON.parse(await readFile("config/testing.json", "utf8"));
if (!/^[a-z][a-z0-9_]+_matching_test$/.test(testing.matching_database_name))
  throw new Error("Dedicated matching evaluation database required");
const url = new URL(process.env.NEXTSIGNAL_DATABASE__URL);
if (url.pathname === `/${testing.matching_database_name}`)
  throw new Error(
    "Launch from the application configuration, not the evaluation database",
  );
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
if (
  !(
    await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
      testing.matching_database_name,
    ])
  ).rowCount
)
  await admin.query(`CREATE DATABASE "${testing.matching_database_name}"`);
await admin.end();
url.pathname = `/${testing.matching_database_name}`;
const categoryOption = process.argv.find((arg) =>
  arg.startsWith("--categories="),
);
const categoryOverride = categoryOption
  ?.slice("--categories=".length)
  .split(",")
  .filter(Boolean);
if (categoryOverride) {
  const definitions = JSON.parse(
    await readFile("prompts/categories.json", "utf8"),
  );
  if (
    categoryOverride.some((label) => !(label in definitions)) ||
    new Set(categoryOverride).size !== categoryOverride.length
  )
    throw new Error("Evaluation categories must be unique predefined labels");
}
const env = {
  ...process.env,
  NEXTSIGNAL_DATABASE__URL: url.href,
  ...(categoryOverride
    ? { NEXTSIGNAL_MATCHING__AI_CATEGORIES: JSON.stringify(categoryOverride) }
    : {}),
  NEXTSIGNAL_MATCHING__AUTOMATIC_ENABLED: "false",
  NEXTSIGNAL_MATCHING__GATEWAY__ENABLED: String(
    process.argv.includes("--paid"),
  ),
};
const migration = spawnSync("npm", ["run", "migrate"], {
  env,
  stdio: "inherit",
});
if (migration.status !== 0) process.exit(migration.status ?? 1);
const result = spawnSync(
  "npx",
  [
    "tsx",
    process.argv.includes("--compare-models")
      ? "scripts/compare-extraction-models.ts"
      : "scripts/evaluate.ts",
    ...process.argv.slice(2),
  ],
  { env, stdio: "inherit" },
);
process.exit(result.status ?? 1);
