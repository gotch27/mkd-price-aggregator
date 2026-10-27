import { randomUUID } from "node:crypto";
import { GatewayCoolingDown } from "@/nextsignal/domain/task-settings";
import { logEvent } from "@/nextsignal/adapters/log-context";
import { transaction, pool } from "./database";
import { matchingConfig, taskContext } from "./task-context";

export type GatewayPermit = { token: string | null };
type Row = {
  failures: number;
  cycles: number;
  retry_at: Date | null;
  probe_token: string | null;
  probe_until: Date | null;
  now: Date;
};

// A shared, durable circuit breaker. No transaction spans a provider request.
export async function acquireGatewayPermit(): Promise<GatewayPermit | null> {
  if (!taskContext()) return null; // Isolated evaluations do not control workers.
  return transaction(async (c) => {
    await c.query(
      "INSERT INTO gateway_cooldown(id) VALUES(true) ON CONFLICT DO NOTHING",
    );
    const row = (
      await c.query<Row>(
        "SELECT *,now() FROM gateway_cooldown WHERE id FOR UPDATE",
      )
    ).rows[0];
    if (!row.retry_at) return { token: null };
    if (row.retry_at > row.now)
      throw new GatewayCoolingDown(row.retry_at.toISOString());
    if (row.probe_until && row.probe_until > row.now)
      throw new GatewayCoolingDown(row.probe_until.toISOString());
    const token = randomUUID();
    await c.query(
      "UPDATE gateway_cooldown SET probe_token=$1,probe_until=now()+$2*interval '1 second',updated_at=now() WHERE id",
      [token, matchingConfig().gateway.cooldown_probe_lease_seconds],
    );
    await logEvent(
      "info",
      "gateway.cooldown.probe",
      "Gateway cooldown finished; trying one pending request",
      { cycles: row.cycles },
    );
    return { token };
  });
}
export async function releaseGatewayPermit(permit: GatewayPermit | null) {
  if (permit?.token)
    await pool.query(
      "UPDATE gateway_cooldown SET probe_token=NULL,probe_until=NULL WHERE id AND probe_token=$1",
      [permit.token],
    );
}
export async function gatewaySucceeded(permit: GatewayPermit | null) {
  if (!permit) return;
  const changed = await pool.query(
    `UPDATE gateway_cooldown SET failures=0,cycles=0,retry_at=NULL,probe_token=NULL,probe_until=NULL,updated_at=now()
     WHERE id AND (failures<>0 OR retry_at IS NOT NULL OR probe_token IS NOT NULL)
       AND (($1::uuid IS NOT NULL AND probe_token=$1) OR ($1::uuid IS NULL AND retry_at IS NULL)) RETURNING id`,
    [permit.token],
  );
  if (permit.token && changed.rowCount)
    await logEvent(
      "info",
      "gateway.cooldown.recovered",
      "Gateway recovery request succeeded; normal processing can continue",
    );
}
export async function gatewayFailed(
  permit: GatewayPermit | null,
  rateLimited: boolean,
) {
  if (!permit) return null;
  const result = await transaction(async (c) => {
    const row = (
      await c.query<Row>(
        "SELECT *,now() FROM gateway_cooldown WHERE id FOR UPDATE",
      )
    ).rows[0];
    if (permit.token ? row.probe_token !== permit.token : row.retry_at !== null)
      return {
        until: row.retry_at?.toISOString() ?? null,
        changed: false,
        cycles: row.cycles,
      };
    const g = matchingConfig().gateway;
    const failures = row.failures + 1;
    if (
      !permit.token &&
      !rateLimited &&
      failures < g.consecutive_failure_limit
    ) {
      await c.query(
        "UPDATE gateway_cooldown SET failures=$1,updated_at=now() WHERE id",
        [failures],
      );
      return { until: null, changed: false, cycles: row.cycles };
    }
    const seconds = Math.min(
      g.cooldown_max_seconds,
      g.cooldown_initial_seconds * 2 ** Math.min(row.cycles, 30),
    );
    const updated = (
      await c.query<{ retry_at: Date }>(
        "UPDATE gateway_cooldown SET failures=$1,cycles=cycles+1,retry_at=now()+$2*interval '1 second',probe_token=NULL,probe_until=NULL,updated_at=now() WHERE id RETURNING retry_at",
        [failures, seconds],
      )
    ).rows[0];
    return {
      until: updated.retry_at.toISOString(),
      changed: true,
      cycles: row.cycles + 1,
    };
  });
  if (result.changed)
    await logEvent(
      "warn",
      "gateway.cooldown.started",
      "Gateway unavailable; waiting before one recovery request",
      { retry_at: result.until, cycles: result.cycles },
    );
  return result.until;
}
