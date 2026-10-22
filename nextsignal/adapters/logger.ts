import { randomUUID } from "node:crypto";
import {
  mkdir,
  writeFile,
  readdir,
  readFile,
  unlink,
  rename,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import type { LoggerAdapter, LogEntry } from "@gotch/nextsignal";
import { settings } from "@/nextsignal/config";
import { pool } from "@/nextsignal/services/database";
import { z } from "zod";
const ranks = { debug: 0, info: 1, warn: 2, error: 3 };
const spoolRecord = z.looseObject({
  id: z.uuid(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  created_at: z.iso.datetime(),
});
export function redact(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return JSON.parse(
    JSON.stringify(value, (key, v: unknown) => {
      if (/password|secret|authorization|cookie|api.?key|token/i.test(key))
        return "[REDACTED]";
      if (v instanceof Error)
        return { name: v.name, message: v.message, stack: v.stack };
      if (typeof v === "string")
        return v
          .replace(/(postgres(?:ql)?:\/\/)[^\s]+/gi, "$1[REDACTED]")
          .replace(/sk-[a-zA-Z0-9_-]+/g, "[REDACTED]");
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    }) ?? "null",
  );
}
async function persist(e: Record<string, unknown>) {
  await pool.query(
    "INSERT INTO logs(id,level,message,process,correlation_id,run_id,retailer,source_id,data,error,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING",
    [
      e.id,
      e.level,
      e.message,
      e.process,
      e.correlation_id,
      e.run_id,
      e.retailer,
      e.source_id,
      e.data,
      e.error,
      e.created_at,
    ],
  );
}
async function log(level: keyof typeof ranks, entry: LogEntry) {
  if (ranks[level] < ranks[settings.logging.level]) return;
  const data = redact(entry.data) as Record<string, unknown> | null;
  const e = {
    id: randomUUID(),
    level,
    message: redact(entry.message),
    process: entry.process ?? null,
    correlation_id: entry.correlationId ?? null,
    run_id: data?.run_id ?? null,
    retailer: data?.retailer ?? null,
    source_id: data?.source_id ?? null,
    data,
    error: redact(entry.error),
    created_at: new Date().toISOString(),
  };
  console[level](JSON.stringify(e));
  try {
    await persist(e);
  } catch {
    try {
      await mkdir(settings.logging.spool_dir, { recursive: true });
      const temporary = join(settings.logging.spool_dir, `${e.id}.tmp`);
      await writeFile(temporary, JSON.stringify(e), {
        mode: 0o600,
        flush: true,
      });
      await rename(temporary, join(settings.logging.spool_dir, `${e.id}.json`));
    } catch (error) {
      console.error("Log spool unavailable", String(error));
    }
  }
}
export async function replayLogs() {
  await mkdir(settings.logging.spool_dir, { recursive: true });
  const entries = await readdir(settings.logging.spool_dir);
  for (const file of entries.filter((file) => file.endsWith(".invalid"))) {
    const path = join(settings.logging.spool_dir, file);
    try {
      if (
        Date.now() - (await stat(path)).mtimeMs >
        settings.logging.operational_days * 86400000
      )
        await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") break;
    }
  }
  const files = entries
    .filter((f) => f.endsWith(".json") || f.endsWith(".tmp"))
    .slice(0, settings.logging.replay_batch);
  for (const file of files) {
    let entry: Record<string, unknown>;
    try {
      const path = join(settings.logging.spool_dir, file);
      if (
        file.endsWith(".tmp") &&
        Date.now() - (await stat(path)).mtimeMs < settings.scheduler.tick_ms
      )
        continue;
      entry = spoolRecord.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError))
        break;
      try {
        await rename(
          join(settings.logging.spool_dir, file),
          join(settings.logging.spool_dir, `${file}.invalid`),
        );
        console.error(
          "Malformed log spool entry retained for inspection",
          file,
        );
      } catch {
        break;
      }
      continue;
    }
    try {
      await persist(entry);
      await unlink(join(settings.logging.spool_dir, file));
    } catch {
      break;
    }
  }
}
export const loggerAdapter: LoggerAdapter = {
  debug: (e) => log("debug", e),
  info: (e) => log("info", e),
  warn: (e) => log("warn", e),
  error: (e) => log("error", e),
};
