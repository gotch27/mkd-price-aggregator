import { CronExpressionParser } from "cron-parser";
import { settings } from "@/nextsignal/config";
import {
  operationalSchema,
  TaskConflict,
  type OperationalPolicy,
  type SavedTaskSettings,
} from "@/nextsignal/domain/task-settings";
import { families } from "@/nextsignal/domain/matching";
import { pool, transaction } from "./database";
import { logEvent } from "@/nextsignal/adapters/log-context";

export function nextOccurrences(cron: string, after: Date, count = 3) {
  const expression = CronExpressionParser.parse(cron, {
    currentDate: after,
    tz: "Europe/Skopje",
  });
  return Array.from({ length: count }, () => expression.next().toISOString()!);
}
export async function readSettings(): Promise<SavedTaskSettings> {
  await pool.query(
    `INSERT INTO operational_settings(id,revision,policy,epochs,updated_by,next_due)
    VALUES(true,1,$1,$2,'deployment',$3) ON CONFLICT DO NOTHING`,
    [
      settings.tasks.defaults,
      { imports: 0, categorization: 0, matching: 0, ai: 0 },
      nextOccurrences(settings.tasks.defaults.cron, new Date(), 1)[0],
    ],
  );
  const row = (
    await pool.query(
      `SELECT revision,policy,epochs,updated_by,updated_at,category_backlog_epoch FROM operational_settings WHERE id`,
    )
  ).rows[0];
  return {
    ...row,
    policy: operationalSchema.parse(row.policy),
    category_backlog_active:
      row.policy.categorization === "automatic" &&
      row.category_backlog_epoch === row.epochs.categorization,
    updated_at: new Date(row.updated_at).toISOString(),
  };
}
export async function saveSettings(
  revision: number,
  policy: OperationalPolicy,
  actor: string,
  authorizeCategoryBacklog?: boolean,
) {
  const parsed = operationalSchema.parse(policy);
  if (authorizeCategoryBacklog && parsed.categorization !== "automatic")
    throw new TaskConflict(
      "Choose Automatic categorization before activating its backlog.",
    );
  const maximumDownloads = settings.queue.concurrency["catalog.download"];
  if (
    parsed.parallel_imports > maximumDownloads ||
    parsed.per_store_downloads > maximumDownloads
  )
    throw new TaskConflict(
      `This worker supports at most ${maximumDownloads} simultaneous downloads.`,
    );
  if (
    parsed.ai_enabled &&
    (!settings.matching.gateway.api_key.trim() ||
      settings.matching.gateway.api_key === "disabled")
  )
    throw new TaskConflict(
      "The AI Gateway key must be configured on the server first.",
    );
  await readSettings();
  let auditChanges: { field: string; before: unknown; after: unknown }[] = [];
  const saved = await transaction(async (c) => {
    const before = (
      await c.query(`SELECT * FROM operational_settings WHERE id FOR UPDATE`)
    ).rows[0];
    if (before.revision !== revision)
      throw new TaskConflict(
        "Settings changed in another session. Reload before saving.",
      );
    const changes = Object.entries(parsed)
      .filter(
        ([key, v]) => JSON.stringify(before.policy[key]) !== JSON.stringify(v),
      )
      .map(([field, after]) => ({
        field,
        before: before.policy[field],
        after,
      }));
    const activateBacklog =
      authorizeCategoryBacklog &&
      (before.policy.categorization !== "automatic" ||
        before.category_backlog_epoch !== before.epochs.categorization);
    if (activateBacklog)
      changes.push({
        field: "categorization_backlog",
        before: false,
        after: true,
      });
    if (!changes.length) return before;
    auditChanges = changes;
    const epochs = { ...before.epochs };
    for (const key of ["imports", "categorization", "matching"] as const)
      if (before.policy[key] !== "automatic" && parsed[key] === "automatic")
        epochs[key]++;
    if (!before.policy.ai_enabled && parsed.ai_enabled) epochs.ai++;
    const scheduleChanged =
      before.policy.cron !== parsed.cron ||
      before.policy.imports !== parsed.imports ||
      JSON.stringify(before.policy.scheduled_stores) !==
        JSON.stringify(parsed.scheduled_stores) ||
      before.policy.paused !== parsed.paused;
    const result = (
      await c.query(
        `UPDATE operational_settings SET revision=revision+1,policy=$1,epochs=$2,updated_by=$3,updated_at=now(),next_due=CASE WHEN $4 THEN $5 ELSE next_due END,
          category_backlog_epoch=CASE WHEN $6 THEN ($2::jsonb->>'categorization')::int ELSE category_backlog_epoch END WHERE id RETURNING *`,
        [
          parsed,
          epochs,
          actor,
          scheduleChanged,
          nextOccurrences(parsed.cron, new Date(), 1)[0],
          authorizeCategoryBacklog === true,
        ],
      )
    ).rows[0];
    await c.query(
      `INSERT INTO operational_settings_history(revision,actor,before_policy,after_policy,changes) VALUES($1,$2,$3,$4,$5)`,
      [result.revision, actor, before.policy, parsed, JSON.stringify(changes)],
    );
    return result;
  });
  await logEvent("info", "tasks.settings.saved", "Task settings saved", {
    actor,
    revision: saved.revision,
    changes: auditChanges,
  });
  return readSettings();
}
export async function settingsHistory(page: number, size: number) {
  const rows = (
    await pool.query(
      `SELECT revision,actor,changes,created_at FROM operational_settings_history ORDER BY revision DESC LIMIT $1 OFFSET $2`,
      [size, (page - 1) * size],
    )
  ).rows;
  const count = (
    await pool.query(
      `SELECT count(*)::int AS total FROM operational_settings_history`,
    )
  ).rows[0].total;
  return { rows, total: count, page, size };
}
export async function settingsView() {
  const saved = await readSettings();
  const workerOnline = (
    await pool.query(
      `SELECT EXISTS(SELECT 1 FROM worker_heartbeats WHERE key='catalog' AND seen_at>now()-$1*interval '1 millisecond') AS online`,
      [settings.worker.heartbeat_max_age_ms],
    )
  ).rows[0].online;
  const counts = (
    await pool.query(
      `SELECT classified_family AS family,count(*)::int AS count FROM store_products WHERE classified_family IS NOT NULL GROUP BY classified_family`,
    )
  ).rows;
  const spending = (
    await pool.query(
      `SELECT coalesce(sum(u.cost_usd) FILTER(WHERE c.kind='initial'),0)::text AS initial_usd,
    coalesce(sum(u.cost_usd) FILTER(WHERE c.kind='incremental' AND date_trunc('month',u.created_at AT TIME ZONE $1)=date_trunc('month',now() AT TIME ZONE $1)),0)::text AS monthly_usd FROM ai_usage u JOIN matching_campaigns c ON c.id=u.campaign_id`,
      [settings.app.timezone],
    )
  ).rows[0];
  return {
    ...saved,
    gateway_recovery: {
      initial_seconds: settings.matching.gateway.cooldown_initial_seconds,
      maximum_seconds: settings.matching.gateway.cooldown_max_seconds,
    },
    worker_limits: {
      max_downloads: settings.queue.concurrency["catalog.download"],
      parallel_publications: settings.ingestion.parallel_publications,
      ready_catalogs: settings.ingestion.max_ready_catalogs,
    },
    spending: {
      ...spending,
      initial_remaining_usd: Math.max(
        0,
        saved.policy.initial_budget_usd - Number(spending.initial_usd),
      ),
      monthly_remaining_usd: Math.max(
        0,
        saved.policy.monthly_budget_usd - Number(spending.monthly_usd),
      ),
    },
    models: {
      decision: settings.matching.gateway.decision_model,
      clarification: settings.matching.gateway.extraction_model,
    },
    key_ready: !(
      !settings.matching.gateway.api_key.trim() ||
      settings.matching.gateway.api_key === "disabled"
    ),
    worker_online: workerOnline,
    stores: Object.entries(settings.sources).map(([slug, s]) => ({
      slug,
      name: s.name,
      enabled: s.enabled,
    })),
    categories: families.map((id) => ({
      id,
      name: id.replaceAll("_", " "),
      count: counts.find((r) => r.family === id)?.count ?? 0,
    })),
    next_runs: nextOccurrences(saved.policy.cron, new Date()),
    timezone: "Europe/Skopje",
  };
}
