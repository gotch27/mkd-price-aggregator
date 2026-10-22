import { readFile, mkdir } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import pg from "pg";
import { settings } from "@/nextsignal/config";

const testing = JSON.parse(await readFile("config/testing.json", "utf8"));
const restoreName: string = testing.restore_database_name;
const backupPath: string = testing.backup_path;
const envFile = process.env.APP_ENV_FILE;
if (!envFile || !backupPath || !/^[a-z][a-z0-9_]*_test$/.test(restoreName))
  throw new Error(
    "Explicit APP_ENV_FILE, testing.backup_path and testing.restore_database_name ending in _test are required",
  );
const url = new URL(settings.database.url);
if (url.pathname === `/${restoreName}`)
  throw new Error("Restore target must be separate");
const user = decodeURIComponent(url.username),
  database = decodeURIComponent(url.pathname.slice(1));
const prefix = ["compose", "--env-file", envFile, "exec", "-T", "postgres"];
function command(
  args: string[],
  input: number | "ignore",
  output: number | "ignore",
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("docker", [...prefix, ...args], {
      stdio: [input, output, "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}`)),
    );
  });
}
const snapshot = new pg.Client({ connectionString: settings.database.url });
const admin = new pg.Client({ connectionString: settings.database.url });
let created = false;
const countsSql =
  "SELECT (SELECT count(*) FROM offers)::text AS offers,(SELECT count(*) FROM listings)::text AS listings,(SELECT count(*) FROM sources)::text AS sources,(SELECT count(*) FROM runs)::text AS runs";
try {
  await admin.connect();
  if (
    (
      await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
        restoreName,
      ])
    ).rowCount
  )
    throw new Error(
      "Restore test database already exists; refusing to replace it",
    );
  await snapshot.connect();
  await snapshot.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const expected = (await snapshot.query(countsSql)).rows[0];
  const snapshotId = (await snapshot.query("SELECT pg_export_snapshot() AS id"))
    .rows[0].id;
  await mkdir(dirname(backupPath), { recursive: true });
  const output = openSync(backupPath, "w", 0o600);
  try {
    await command(
      ["pg_dump", "-U", user, "-d", database, "-Fc", "--snapshot", snapshotId],
      "ignore",
      output,
    );
  } finally {
    closeSync(output);
  }
  await snapshot.query("COMMIT");
  await admin.query(`CREATE DATABASE "${restoreName}"`);
  created = true;
  const input = openSync(backupPath, "r");
  try {
    await command(
      ["pg_restore", "-U", user, "-d", restoreName, "--exit-on-error"],
      input,
      "ignore",
    );
  } finally {
    closeSync(input);
  }
  url.pathname = `/${restoreName}`;
  const restored = new pg.Client({ connectionString: url.href });
  try {
    await restored.connect();
    const actual = (await restored.query(countsSql)).rows[0];
    assert.deepEqual(actual, expected);
    assert.equal(
      (
        await restored.query(
          "SELECT count(*)::int AS n FROM offers o LEFT JOIN sources s ON s.id=o.source_id LEFT JOIN listings l ON l.id=o.listing_id WHERE s.id IS NULL OR l.id IS NULL",
        )
      ).rows[0].n,
      0,
    );
    console.info({
      result: "Backup restoration passed",
      snapshot_counts: actual,
      backup: backupPath,
    });
  } finally {
    await restored.end();
  }
} finally {
  await snapshot.end();
  if (created) await admin.query(`DROP DATABASE "${restoreName}" WITH (FORCE)`);
  await admin.end();
}
