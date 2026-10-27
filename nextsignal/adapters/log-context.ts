import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { LoggerAdapter } from "@gotch/nextsignal";
import { loggerAdapter } from "@/nextsignal/adapters/logger";

type LogContext = {
  logger?: LoggerAdapter;
  process?: string;
  correlationId?: string;
  data?: Record<string, unknown>;
};
const contexts = new AsyncLocalStorage<LogContext>();

// Scope metadata, never credentials or provider payloads. AsyncLocalStorage keeps
// concurrent runs/products isolated while services use the process's adapter.
export function withLogContext<T>(context: LogContext, operation: () => T): T {
  const parent = contexts.getStore();
  return contexts.run(
    {
      logger: context.logger ?? parent?.logger ?? loggerAdapter,
      process: context.process ?? parent?.process,
      correlationId:
        context.correlationId ?? parent?.correlationId ?? randomUUID(),
      data: { ...parent?.data, ...context.data },
    },
    operation,
  );
}

export async function logEvent(
  level: "debug" | "info" | "warn" | "error",
  event: string,
  message: string,
  data: Record<string, unknown> = {},
  error?: unknown,
) {
  const context = contexts.getStore();
  const entry = {
    message,
    process: context?.process ?? event.slice(0, event.lastIndexOf(".")),
    correlationId: context?.correlationId ?? randomUUID(),
    data: { ...context?.data, ...data, event },
    error,
  };
  try {
    await (context?.logger ?? loggerAdapter)[level]?.(entry);
  } catch {
    // A broken injected logger must not undo a committed match or cause an
    // already-billed Gateway request to be repeated. The standard adapter owns
    // persistence, redaction, stdout and the outage spool, including this fault.
    try {
      await loggerAdapter.error({
        ...entry,
        message: "Operation logger failed",
        error: undefined,
        data: {
          ...context?.data,
          event: "logging.adapter.failed",
          failed_event: event,
        },
      });
    } catch {
      /* Keep logging failures outside business outcomes. */
    }
  }
}
