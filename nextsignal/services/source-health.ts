import { settings } from "@/nextsignal/config";
import { SourceDeferred } from "@/nextsignal/domain/types";
import { logEvent } from "@/nextsignal/adapters/log-context";
import { pool } from "./database";

export async function assertHostReady(host: string) {
  const row = (
    await pool.query<{
      until: string | null;
      failure_at: string | null;
      blocked: boolean;
    }>(
      `SELECT cooldown_until::text AS until,last_failure_at::text AS failure_at,cooldown_until>clock_timestamp() AS blocked FROM host_limits WHERE host=$1`,
      [host],
    )
  ).rows[0];
  if (row?.blocked && row.until)
    throw new SourceDeferred(host, new Date(row.until).toISOString());
  return row?.failure_at ?? null;
}

export async function blockedRetailers() {
  const hosts = (
    await pool.query<{ host: string; until: string }>(
      `SELECT host,cooldown_until::text AS until FROM host_limits WHERE cooldown_until>clock_timestamp()`,
    )
  ).rows;
  const blocked = new Map(hosts.map((row) => [row.host, row.until]));
  return Object.entries(settings.sources).flatMap(([retailer, source]) => {
    const until = [source.url, source.api_url, source.catalog_api_url]
      .flatMap((url) => (url ? [blocked.get(new URL(url).host)] : []))
      .filter((value): value is string => value !== undefined)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    return until ? [{ retailer, until: new Date(until).toISOString() }] : [];
  });
}

export async function recordHostSuccess(
  host: string,
  observedFailure: string | null,
) {
  const recovered = (
    await pool.query<{ failures: number }>(
      `WITH previous AS (SELECT consecutive_failures AS failures FROM host_limits WHERE host=$1 AND last_failure_at IS NOT DISTINCT FROM $2::timestamptz FOR UPDATE),
       updated AS (UPDATE host_limits SET consecutive_failures=0,cooldown_until=NULL,last_success_at=clock_timestamp() WHERE host=$1 AND last_failure_at IS NOT DISTINCT FROM $2::timestamptz RETURNING host)
       SELECT failures FROM previous,updated`,
      [host, observedFailure],
    )
  ).rows[0];
  if (
    recovered &&
    recovered.failures >= settings.http.cooldown.failure_threshold
  )
    await logEvent(
      "info",
      "source.cooldown.recovered",
      "Store downloads recovered",
      {
        host,
        previous_failures: recovered.failures,
      },
    );
}

export async function recordHostFailure(host: string, retryAfter: Date | null) {
  const { failure_threshold, base_ms, max_ms } = settings.http.cooldown;
  const row = (
    await pool.query<{ failures: number; until: string | null }>(
      `UPDATE host_limits SET consecutive_failures=consecutive_failures+1,last_failure_at=clock_timestamp(),
       cooldown_until=CASE WHEN consecutive_failures+1 >= $2 OR $5::timestamptz IS NOT NULL THEN
         greatest(cooldown_until,$5::timestamptz,clock_timestamp()+
           least($4::numeric,$3::numeric*power(2::numeric,least(20,greatest(0,(consecutive_failures+1-$2)/$2))))*interval '1 millisecond')
         ELSE cooldown_until END
       WHERE host=$1 RETURNING consecutive_failures AS failures,cooldown_until::text AS until`,
      [host, failure_threshold, base_ms, max_ms, retryAfter],
    )
  ).rows[0];
  if (row?.until)
    await logEvent(
      "warn",
      "source.cooldown.started",
      "Store downloads are cooling down; other stores can continue",
      {
        host,
        consecutive_failures: row.failures,
        retry_at: new Date(row.until).toISOString(),
      },
    );
  return row?.until ? new Date(row.until).toISOString() : null;
}
