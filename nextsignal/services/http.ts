import { settings } from "@/nextsignal/config";
import { transaction } from "./database";
import { SourceError } from "@/nextsignal/domain/types";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function fetchBytes(
  url: string,
  init: RequestInit = {},
): Promise<{ bytes: Buffer; headers: Headers }> {
  const host = new URL(url).host;
  const interval = settings.http.host_intervals_ms[host];
  if (interval === undefined)
    throw new SourceError(`Missing http.host_intervals_ms for ${host}`, false);
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
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { "user-agent": settings.http.user_agent, ...init.headers },
      signal: AbortSignal.timeout(settings.http.timeout_ms),
    });
  } catch (error) {
    throw new SourceError(`Fetch failed for ${host}: ${String(error)}`, true);
  }
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    if (retry) {
      const until = /^\d+$/.test(retry)
        ? new Date(Date.now() + Number(retry) * 1000)
        : new Date(retry);
      if (Number.isFinite(until.getTime()))
        await transaction((c) =>
          c.query(
            "UPDATE host_limits SET next_at=greatest(next_at,$2) WHERE host=$1",
            [host, until],
          ),
        );
    }
    throw new SourceError(
      `HTTP ${response.status} from ${url}`,
      response.status === 429 || response.status >= 500,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SourceError("Empty HTTP response", true);
  const parts: Buffer[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
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
  return { bytes: Buffer.concat(parts), headers: response.headers };
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
