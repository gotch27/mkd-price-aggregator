import { readFile } from "node:fs/promises";
const config = JSON.parse(await readFile("config/default.json", "utf8"));
const maxAge =
  process.env.NEXTSIGNAL_WORKER__HEARTBEAT_MAX_AGE_MS === undefined
    ? config.worker.heartbeat_max_age_ms
    : Number(process.env.NEXTSIGNAL_WORKER__HEARTBEAT_MAX_AGE_MS);
if (!Number.isFinite(maxAge) || maxAge <= 0)
  throw new Error("Missing or invalid worker.heartbeat_max_age_ms");
const heartbeat = Date.parse(
  await readFile(
    process.env.NEXTSIGNAL_WORKER__HEARTBEAT_FILE === undefined
      ? config.worker.heartbeat_file
      : process.env.NEXTSIGNAL_WORKER__HEARTBEAT_FILE,
    "utf8",
  ),
);
if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > maxAge)
  process.exit(1);
