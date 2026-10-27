import {
  GatewayCoolingDown,
  operationFor,
  TaskPaused,
  type TaskExecution,
} from "@/nextsignal/domain/task-settings";
import { logEvent } from "@/nextsignal/adapters/log-context";
import { transaction, pool } from "./database";
import { readSettings } from "./task-settings";
import { assertPermission } from "./task-context";

export async function coolTask(
  task: TaskExecution,
  cooldown: GatewayCoolingDown,
) {
  const live = await readSettings();
  try {
    assertPermission(task, live, task.options.use_ai);
  } catch (error) {
    if (error instanceof TaskPaused) return false;
    throw error;
  }
  if (live.policy[operationFor(task.kind)] !== "automatic") return false;
  const changed = await pool.query(
    `UPDATE task_executions SET state='cooldown',retry_at=$2,reason=$3,dispatch_until=NULL,updated_at=now()
     WHERE id=$1 AND state IN ('queued','running') RETURNING id`,
    [task.id, cooldown.retryAt, cooldown.message],
  );
  if (changed.rowCount)
    await logEvent(
      "warn",
      "tasks.cooldown.started",
      "Task waiting for Gateway recovery; automatic processing stays enabled",
      { task_id: task.id, retry_at: cooldown.retryAt },
    );
  return true; // A concurrent manual pause must not be overwritten.
}

export async function wakeCoolingTasks() {
  const live = await readSettings();
  if (live.policy.paused) return;
  const events = await transaction(async (c) => {
    // Serialize permission changes with waking checkpoints.
    const version = (
      await c.query(
        "SELECT revision FROM operational_settings WHERE id FOR SHARE",
      )
    ).rows[0].revision;
    if (version !== live.revision) return [];
    const tasks = (
      await c.query<TaskExecution & { due: boolean }>(
        "SELECT *,retry_at<=now() AS due FROM task_executions WHERE state='cooldown' FOR UPDATE SKIP LOCKED",
      )
    ).rows;
    const events: { task_id: string; paused: boolean; reason: string }[] = [];
    for (const task of tasks) {
      let reason: string | null = null;
      try {
        assertPermission(task, live, task.options.use_ai);
      } catch (error) {
        if (error instanceof TaskPaused) reason = error.message;
        else throw error;
      }
      if (live.policy[operationFor(task.kind)] !== "automatic")
        reason =
          "Automatic recovery is disabled. Resume this task explicitly to continue.";
      if (reason) {
        await c.query(
          "UPDATE task_executions SET state='paused',reason=$2,updated_at=now() WHERE id=$1",
          [task.id, reason],
        );
        events.push({ task_id: task.id, paused: true, reason });
      } else if (task.due) {
        await c.query(
          "UPDATE task_executions SET state='queued',retry_at=NULL,dispatch_until=NULL,reason='Gateway cooldown finished; waiting for one recovery request',updated_at=now() WHERE id=$1",
          [task.id],
        );
        events.push({
          task_id: task.id,
          paused: false,
          reason: "Gateway cooldown finished",
        });
      }
    }
    return events;
  });
  for (const event of events)
    await logEvent(
      event.paused ? "warn" : "info",
      event.paused ? "tasks.cooldown.held" : "tasks.cooldown.resumed",
      event.paused
        ? "Automatic recovery held by current permissions"
        : "Task queued after Gateway cooldown",
      event,
    );
}
