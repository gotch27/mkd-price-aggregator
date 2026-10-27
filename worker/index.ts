import { createBackgroundHost } from "@gotch/nextsignal/worker";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { app } from "@/nextsignal/app";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import { loggerAdapter, replayLogs } from "@/nextsignal/adapters/logger";
import { readSettings } from "@/nextsignal/services/task-settings";
import { recoverAuthorizedWork } from "@/nextsignal/services/tasks";
import { refreshProductStatistics } from "@/nextsignal/services/product-statistics";
await readSettings();
await recoverAuthorizedWork();
const host = createBackgroundHost(app);
await host.start();
await loggerAdapter.info({ message: "Catalog background host started" });
await mkdir(dirname(settings.worker.heartbeat_file), { recursive: true });
await writeFile(settings.worker.heartbeat_file, new Date().toISOString());
await pool.query(
  "INSERT INTO worker_heartbeats(key,seen_at) VALUES('catalog',now()) ON CONFLICT(key) DO UPDATE SET seen_at=excluded.seen_at",
);
const heartbeat = setInterval(() => {
  void pool
    .query(
      "INSERT INTO worker_heartbeats(key,seen_at) VALUES('catalog',now()) ON CONFLICT(key) DO UPDATE SET seen_at=excluded.seen_at",
    )
    .then(() =>
      writeFile(settings.worker.heartbeat_file, new Date().toISOString()),
    )
    .catch((error) =>
      loggerAdapter.error({ message: "Worker heartbeat failed", error }),
    );
}, settings.scheduler.tick_ms);
await refreshProductStatistics();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    clearInterval(heartbeat);
    await host.stop();
    await replayLogs();
    await pool.end();
    process.exit(0);
  });
