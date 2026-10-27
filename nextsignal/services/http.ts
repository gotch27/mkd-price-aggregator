import { checkpoint } from "./task-context";
import { settings } from "@/nextsignal/config";
import { transaction } from "./database";
import { SourceError } from "@/nextsignal/domain/types";
import { TaskPaused } from "@/nextsignal/domain/task-settings";
import { logEvent } from "@/nextsignal/adapters/log-context";
import { Agent } from "undici";
import { sourceResponseError } from "./source-response";
import {
  assertHostReady,
  recordHostFailure,
  recordHostSuccess,
} from "./source-health";

// Applies only to retailer downloads. Gateway requests retain their own client
// and permissions. No network connection opens until fetch uses this dispatcher.
const sourceDispatcher = new Agent({
  connect: { timeout: settings.http.connect_timeout_ms },
});

function networkError(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current instanceof Error && current.cause) current = current.cause;
    else if (current instanceof AggregateError && current.errors.length)
      current = current.errors[0];
    else break;
  }
  return {
    code:
      current &&
      typeof current === "object" &&
      "code" in current &&
      typeof current.code === "string"
        ? current.code
        : null,
    message: current instanceof Error ? current.message : null,
  };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
class ResponseIdleError extends Error {
  constructor() {
    super("The response stopped sending data");
    this.name = "ResponseIdleError";
  }
}
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new ResponseIdleError();
          reject(error);
          controller.abort(error);
        }, settings.http.response_idle_timeout_ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function fetchBytes(
  url: string,
  init: RequestInit = {},
): Promise<{ bytes: Buffer; headers: Headers }> {
  await checkpoint();
  const host = new URL(url).host;
  const interval = settings.http.host_intervals_ms[host];
  const timeout = settings.http.host_timeout_ms[host];
  if (interval === undefined || timeout === undefined)
    throw new SourceError(`Missing http.host_intervals_ms for ${host}`, false);
  await assertHostReady(host);
  const wait = await transaction(async (c) => {
    await c.query(
      "INSERT INTO host_limits(host,next_at) VALUES($1,now()) ON CONFLICT DO NOTHING",
      [host],
    );
    const { rows } = await c.query(
      "UPDATE host_limits SET next_at=greatest(next_at,now())+($2*interval '1 millisecond') WHERE host=$1 RETURNING greatest(0,extract(epoch FROM(next_at-now()))*1000-$2) AS wait",
      [host, interval],
    );
    return Number(rows[0].wait);
  });
  if (wait > 0) await pause(wait);
  await checkpoint();
  const observedFailure = await assertHostReady(host);
  const started = Date.now();
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let length = 0;
  let retryAfter: Date | null = null;
  await logEvent("debug", "source.http.started", "Source request started", {
    host,
    method: init.method ?? "GET",
    timeout_ms: timeout,
    connect_timeout_ms: settings.http.connect_timeout_ms,
    idle_timeout_ms: settings.http.response_idle_timeout_ms,
  });
  try {
    response = await fetch(url, {
      ...init,
      headers: { "user-agent": settings.http.user_agent, ...init.headers },
      signal: AbortSignal.any([
        AbortSignal.timeout(timeout),
        controller.signal,
        ...(init.signal ? [init.signal] : []),
      ]),
      dispatcher: sourceDispatcher,
    } as RequestInit & { dispatcher: Agent });
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      if (retry) {
        const until = /^\d+$/.test(retry)
          ? new Date(Date.now() + Number(retry) * 1000)
          : new Date(retry);
        if (Number.isFinite(until.getTime())) retryAfter = until;
      }
      throw new SourceError(
        `HTTP ${response.status} from ${url}`,
        response.status === 429 || response.status >= 500,
      );
    }
    reader = response.body?.getReader();
    if (!reader) throw new SourceError("Empty HTTP response", true);
    const parts: Buffer[] = [];
    while (true) {
      const { done, value } = await readChunk(reader, controller);
      if (done) break;
      length += value.byteLength;
      if (length > settings.http.max_bytes) {
        await reader.cancel();
        throw new SourceError(
          `Response exceeds configured byte limit: ${url}`,
          false,
        );
      }
      parts.push(Buffer.from(value));
    }
    const expected = response.headers.get("content-length");
    // Fetch can decode compressed responses, whose encoded content length is
    // not the size of the decoded byte stream.
    if (
      expected &&
      !response.headers.has("content-encoding") &&
      /^\d+$/.test(expected) &&
      Number(expected) !== length
    )
      throw new SourceError(
        `Incomplete response from ${host}: ${length} of ${expected} bytes received`,
        true,
      );
    const bytes = Buffer.concat(parts);
    const responseError = sourceResponseError(bytes);
    if (responseError) throw responseError;
    try {
      await recordHostSuccess(host, observedFailure);
    } catch (error) {
      await logEvent(
        "error",
        "source.health.unavailable",
        "Store download health could not be saved; work is paused",
        { host },
        error,
      );
      throw new TaskPaused("Waiting: store download health cannot be saved");
    }
    await logEvent(
      "debug",
      "source.http.completed",
      "Source response downloaded",
      {
        host,
        status: response.status,
        received_bytes: length,
        duration_ms: Date.now() - started,
      },
    );
    return { bytes, headers: response.headers };
  } catch (error) {
    if (error instanceof TaskPaused) throw error;
    const expected = response?.headers.get("content-length");
    const received = expected
      ? `${length} of ${expected} bytes received`
      : `${length} bytes received`;
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    const idleTimeout = error instanceof ResponseIdleError;
    const network = networkError(error);
    const connectionTimedOut = network.code === "UND_ERR_CONNECT_TIMEOUT";
    const failure =
      error instanceof SourceError
        ? error
        : new SourceError(
            connectionTimedOut
              ? `Connection to ${host} exceeded the ${settings.http.connect_timeout_ms / 1000}-second connection limit [${network.code}].`
              : idleTimeout
                ? `Download from ${host} stopped sending data for ${settings.http.response_idle_timeout_ms / 1000} seconds (${received}).`
                : timedOut
                  ? `Timed out downloading from ${host} after ${timeout / 1000} seconds (${received}).`
                  : `Download failed for ${host} (${received}): ${network.code ? `[${network.code}] ${network.message}` : String(error)}`,
            true,
          );
    failure.diagnostics = {
      host,
      status: response?.status ?? null,
      received_bytes: length,
      expected_bytes:
        expected === null || expected === undefined ? null : Number(expected),
      duration_ms: Date.now() - started,
      retryable: failure.retryable,
      phase: connectionTimedOut
        ? "connection"
        : response
          ? response.ok
            ? idleTimeout
              ? "body_idle"
              : "body"
            : "response"
          : "connection_or_headers",
      error_code: network.code,
      network_message: network.message,
      connect_timeout_ms: settings.http.connect_timeout_ms,
      timeout_ms: timeout,
      idle_timeout_ms: settings.http.response_idle_timeout_ms,
      ...failure.diagnostics,
    };
    try {
      failure.diagnostics.retry_at = failure.retryable
        ? await recordHostFailure(host, retryAfter)
        : null;
    } catch (healthError) {
      await logEvent(
        "error",
        "source.health.unavailable",
        "Store download health could not be saved; work is paused",
        { ...failure.diagnostics, download_error: failure.message },
        healthError,
      );
      throw new TaskPaused("Waiting: store download health cannot be saved");
    }
    await logEvent(
      "debug",
      "source.http.failed",
      "Source download failed",
      failure.diagnostics,
      failure,
    );
    throw failure;
  } finally {
    controller.abort();
    // Always release response bodies, including provider errors and a database
    // outage while saving health. Cleanup must not replace the original fault.
    try {
      if (reader) {
        await reader.cancel();
        reader.releaseLock();
      } else if (response?.body && !response.body.locked) {
        await response.body.cancel();
      }
    } catch {
      /* Aborted sockets can reject cancellation. */
    }
  }
}
export async function fetchText(url: string, init?: RequestInit) {
  return (await fetchBytes(url, init)).bytes.toString("utf8");
}
export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const text = await fetchText(url, init);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SourceError(`Invalid JSON from ${url}`, true);
  }
}
