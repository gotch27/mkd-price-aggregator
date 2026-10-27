"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Pause, Play, RefreshCw, ArrowRight } from "lucide-react";
import type {
  TaskSettingsView,
  TaskExecution,
} from "@/nextsignal/domain/task-settings";
import type { TaskRequest, Row } from "./types";
import { storeName, text } from "./types";
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { TaskSettingsForm } from "./task-settings-form";
import { RunForm } from "./task-run-form";
import { taskLabels } from "./task-labels";
import { PageActions } from "./page-actions";
import { taskApi } from "./task-api";
import { TaskResults } from "./task-results";

type Page<T> = { rows: T[]; total: number; page: number; size: number };
type Run = TaskExecution & {
  spent_usd: string;
  requests: number;
  deferred: number;
  uncertain_requests: number;
  published_catalogs: number;
  total_catalogs: number;
  unstarted_catalogs: number;
  failed_catalogs: number;
  failed_discoveries: number;
  failure_stores: string[];
  saved_pages: number;
  downloading_catalogs: number;
  publishing_catalogs: number;
  ready_catalogs: number;
};

function TaskProgress({ task }: { task: Run }) {
  if (task.kind === "discover")
    return (
      <>
        {task.processed} / {task.options.retailers.length} stores checked
      </>
    );
  if (task.kind === "import")
    return (
      <>
        {task.published_catalogs} / {task.total_catalogs} catalogs imported
        <p className="text-xs text-muted-foreground">
          {task.unstarted_catalogs} waiting for a first turn ·{" "}
          {task.failed_catalogs} catalogs need retry
        </p>
        {task.failed_discoveries > 0 && (
          <p className="text-xs text-muted-foreground">
            {task.failed_discoveries} store lists need retry:{" "}
            {task.failure_stores.map(storeName).join(", ")}
          </p>
        )}
        {task.saved_pages > 0 && (
          <p className="text-xs text-muted-foreground">
            {task.saved_pages} downloaded pages saved in unfinished catalogs
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {task.downloading_catalogs} downloading · {task.ready_catalogs}{" "}
          waiting to save · {task.publishing_catalogs} saving
        </p>
      </>
    );
  return (
    <>
      {task.processed}
      {task.options.product_limit !== null
        ? ` / ${task.options.product_limit}`
        : ""}{" "}
      products checked
      {task.kind === "match" && (
        <p className="text-xs text-muted-foreground">
          {task.connected} connected · {task.unresolved} unresolved
        </p>
      )}
      {task.kind === "categorize" && (
        <p className="text-xs text-muted-foreground">
          {task.processed - task.unresolved} category results saved ·{" "}
          {task.unresolved} without a result
        </p>
      )}
      {task.deferred > 0 && (
        <p className="text-xs text-muted-foreground">
          {task.deferred} set aside for recovery
        </p>
      )}
    </>
  );
}
export function Tasks({
  section,
  actionsTarget,
  update,
  pageSize,
  refreshMs,
  retry,
  onReview,
  onDismissRetry,
  onUpdates,
  onUnauthorized,
  onProduct,
}: {
  section: "run" | "settings";
  actionsTarget: HTMLElement | null;
  update: { revision: number; createdId: string | null };
  pageSize: number;
  refreshMs: number;
  retry: Row | null;
  onReview: (task: TaskRequest) => void;
  onDismissRetry: () => void;
  onUpdates: () => void;
  onUnauthorized: () => void;
  onProduct: (id: string) => void;
}) {
  const [view, setView] = useState<TaskSettingsView | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [taskPage, setTaskPage] = useState(1),
    [runs, setRuns] = useState<Page<Run> | null>(null),
    [formVersion, setFormVersion] = useState(0);
  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const sequence = ++latestLoad.current;
    try {
      const [settings, tasks] = await Promise.all([
        taskApi<TaskSettingsView>("/api/task-settings", onUnauthorized),
        section === "run"
          ? taskApi<Page<Run>>(
              `/api/tasks?page=${taskPage}&size=10`,
              onUnauthorized,
            )
          : Promise.resolve(null),
      ]);
      if (sequence !== latestLoad.current) return;
      setView(settings);
      setRuns(tasks);
      setError("");
    } catch (e) {
      if (sequence === latestLoad.current)
        setError(
          e instanceof Error ? e.message : "Could not load task settings",
        );
    }
  }, [onUnauthorized, taskPage, section]);
  useEffect(() => {
    setTaskPage(1);
  }, [update.createdId]);
  useEffect(() => {
    void load();
    const interval = setInterval(() => {
      void load();
    }, refreshMs);
    return () => clearInterval(interval);
  }, [load, refreshMs, update.revision]);
  async function pauseAll() {
    if (!view) return;
    setBusy(true);
    try {
      await taskApi("/api/task-settings", onUnauthorized, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision: view.revision,
          policy: { ...view.policy, paused: !view.policy.paused },
        }),
      });
      await load();
      setFormVersion((v) => v + 1);
      toast.success(
        view.policy.paused ? "Global pause removed" : "All work paused",
        {
          description: view.policy.paused
            ? "Individually paused tasks stay paused."
            : "An in-flight request may finish before work pauses.",
        },
      );
    } catch (e) {
      toast.error("Could not change pause setting", {
        description: e instanceof Error ? e.message : "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }
  if (!view)
    return (
      <div className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Task settings unavailable</AlertTitle>
            <AlertDescription>
              {error}
              <Button variant="outline" onClick={() => void load()}>
                Reload
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <Skeleton className="h-72 w-full" />
        )}
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      {section === "run" && (
        <PageActions target={actionsTarget}>
          <Badge variant={view.worker_online ? "secondary" : "warning"}>
            {view.worker_online ? "Worker ready" : "Worker offline"}
          </Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh task status"
            title="Refresh task status"
            onClick={() => void load()}
          >
            <RefreshCw />
          </Button>
          <Button
            variant={view.policy.paused ? "default" : "outline"}
            size="sm"
            disabled={busy}
            onClick={() => void pauseAll()}
            title={
              view.policy.paused
                ? "Remove the global pause. Individually paused tasks stay paused."
                : "Pause work at the next safe checkpoint."
            }
          >
            {view.policy.paused ? (
              <Play data-icon="inline-start" />
            ) : (
              <Pause data-icon="inline-start" />
            )}
            {view.policy.paused ? "Resume work" : "Pause all work"}
          </Button>
        </PageActions>
      )}
      {section === "run" && !view.worker_online && (
        <Alert>
          <AlertTitle>Worker is offline</AlertTitle>
          <AlertDescription>
            You can save settings and review tasks. Accepted work waits until
            the worker starts.
          </AlertDescription>
        </Alert>
      )}
      {section === "run" && view.policy.paused && (
        <Alert>
          <AlertTitle>All work is paused</AlertTitle>
          <AlertDescription>
            An in-flight request may finish. Removing the global pause does not
            resume individually paused tasks.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Task controls need attention</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {section === "run" ? (
        <div className="flex flex-col gap-4">
          {retry && (
            <Alert>
              <AlertTitle>Start a reviewed replacement task</AlertTitle>
              <AlertDescription>
                {text(retry.error, "This update did not finish.")} Choose its
                store or catalog below and review a new task. Old queued work
                stays held.
                <Button variant="ghost" size="sm" onClick={onDismissRetry}>
                  Dismiss
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <RunForm
            key={`${view.policy.default_product_limit}-${view.policy.task_budget_usd}`}
            view={view}
            pageSize={pageSize}
            onReview={onReview}
            onUnauthorized={onUnauthorized}
          />
          <Card>
            <CardHeader>
              <CardTitle>Task activity</CardTitle>
              <CardAction>
                <Button variant="ghost" size="sm" onClick={onUpdates}>
                  View data updates
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              {runs?.rows.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Task & scope</TableHead>
                      <TableHead>Progress</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>AI spending</TableHead>
                      <TableHead>Controls</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.rows.map((task) => (
                      <TableRow key={task.id}>
                        <TableCell className="whitespace-normal">
                          <p>{taskLabels[task.kind]}</p>
                          <p className="text-muted-foreground">
                            {task.options.retailers.map(storeName).join(", ")} ·{" "}
                            {task.origin}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(task.created_at).toLocaleString("en-GB", {
                              timeZone: view.timezone,
                            })}
                          </p>
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <TaskProgress task={task} />
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <Badge
                            variant={
                              task.state === "failed"
                                ? "destructive"
                                : "secondary"
                            }
                          >
                            {task.state === "cooldown"
                              ? "Cooling down"
                              : task.state}
                          </Badge>
                          <p className="mt-1 max-w-64 text-xs text-muted-foreground">
                            {task.state === "paused" &&
                            task.uncertain_requests > 0 &&
                            /billing|Identical request|Gateway HTTP 5/.test(
                              task.reason,
                            )
                              ? "A previous AI request needs recovery. Resume to set it aside and continue other products."
                              : task.reason}
                          </p>
                          {task.state === "cooldown" && task.retry_at && (
                            <p className="text-xs text-muted-foreground">
                              Next recovery check after{" "}
                              {new Date(task.retry_at).toLocaleTimeString(
                                "en-GB",
                                { timeZone: view.timezone },
                              )}
                              . Automatic stays enabled.
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          {task.options.use_ai
                            ? `$${Number(task.spent_usd).toFixed(4)} / $${task.options.max_cost_usd.toFixed(2)}`
                            : "Code only"}
                          <p className="text-xs text-muted-foreground">
                            {task.requests} requests
                          </p>
                          {task.uncertain_requests > 0 && (
                            <p className="max-w-48 text-xs text-muted-foreground">
                              Includes reserved cost for{" "}
                              {task.uncertain_requests} unconfirmed{" "}
                              {task.uncertain_requests === 1
                                ? "request"
                                : "requests"}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            {task.kind === "categorize" && (
                              <TaskResults
                                id={task.id}
                                updatedAt={task.updated_at}
                                pageSize={pageSize}
                                onUnauthorized={onUnauthorized}
                                onProduct={onProduct}
                                onCategoryChanged={() => void load()}
                              />
                            )}
                            {task.state === "completed" &&
                              task.deferred > 0 && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    onReview({
                                      endpoint: "/api/tasks/control",
                                      body: {
                                        id: task.id,
                                        action: "retry_deferred",
                                        revision: view.revision,
                                      },
                                      title: "Retry deferred products?",
                                      scope: `${task.deferred} products · ${taskLabels[task.kind]}`,
                                      effect: `Retry only the products set aside by this task. Saved results stay saved. The original $${task.options.max_cost_usd.toFixed(2)} total allowance and ${task.policy.task_request_limit.toLocaleString("en-GB")} request limit still apply. Saved AI responses are reused; requests with uncertain billing are not sent again. Products that still cannot be recovered stay deferred.`,
                                      submitLabel: "Retry deferred products",
                                      successMessage:
                                        "Deferred products queued for recovery.",
                                    })
                                  }
                                >
                                  <RefreshCw data-icon="inline-start" />
                                  Retry deferred
                                </Button>
                              )}
                            {task.state !== "completed" &&
                              (task.state !== "failed" ||
                                ["import", "discover"].includes(task.kind)) && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    onReview({
                                      endpoint: "/api/tasks/control",
                                      body: {
                                        id: task.id,
                                        action: ["paused", "failed"].includes(
                                          task.state,
                                        )
                                          ? "resume"
                                          : "pause",
                                        revision: view.revision,
                                        adopt_import_limits:
                                          ["import", "discover"].includes(
                                            task.kind,
                                          ) &&
                                          ["paused", "failed"].includes(
                                            task.state,
                                          ),
                                      },
                                      title: ["paused", "failed"].includes(
                                        task.state,
                                      )
                                        ? "Continue unfinished work?"
                                        : "Pause this task?",
                                      scope: `${taskLabels[task.kind]} · ${task.options.retailers.map(storeName).join(", ")}`,
                                      effect: `${["import", "discover"].includes(task.kind) && ["paused", "failed"].includes(task.state) ? `Review download limits: ${view.policy.parallel_imports} overall, up to ${view.policy.per_store_downloads} from each store, and one final save at a time. ` : ""}${task.options.use_ai ? `AI is allowed for this task${task.kind === "match" ? ` in these saved categories: ${task.options.categories.join(", ")}` : ""}.` : "Code only; no AI calls."} ${task.kind === "match" || task.kind === "categorize" ? `Keep the original ${task.options.product_limit ?? "all pending"} product limit and $${task.options.max_cost_usd.toFixed(2)} total allowance.` : "Keep the reviewed stores and catalogs. Completed catalogs stay saved; failed downloads get a new bounded retry cycle."} Saved progress and connections remain. ${["paused", "failed"].includes(task.state) ? "Continue explicitly under the current permissions." : "The current request may finish."}`,
                                      submitLabel: [
                                        "paused",
                                        "failed",
                                      ].includes(task.state)
                                        ? task.state === "failed"
                                          ? "Retry unfinished work"
                                          : "Resume task"
                                        : "Pause task",
                                      successMessage: "Task control saved.",
                                    })
                                  }
                                >
                                  {task.state === "failed"
                                    ? "Retry unfinished"
                                    : task.state === "paused"
                                      ? "Resume"
                                      : "Pause"}
                                </Button>
                              )}
                            {["queued", "running"].includes(task.state) &&
                              task.manual_authorized &&
                              ["import", "discover"].includes(task.kind) &&
                              task.failure_stores.length > 0 && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    onReview({
                                      endpoint: "/api/tasks/control",
                                      body: {
                                        id: task.id,
                                        action: "retry_failed",
                                        revision: view.revision,
                                        retry_stores: task.failure_stores,
                                      },
                                      title: "Retry failed work only?",
                                      scope: task.failure_stores
                                        .map(storeName)
                                        .join(", "),
                                      effect:
                                        "Retry failed store lists and catalogs in these stores within the original task. Completed catalogs stay saved and current work continues. Keep the original download limits. No AI calls.",
                                      submitLabel: "Retry failed only",
                                      successMessage:
                                        "Failed work queued for retry.",
                                    })
                                  }
                                >
                                  <RefreshCw data-icon="inline-start" />
                                  Retry failed
                                </Button>
                              )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No task activity yet</EmptyTitle>
                    <EmptyDescription>
                      Your reviewed tasks will appear here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
            {!!runs && runs.total > 10 && (
              <CardFooter className="justify-end">
                <Pager
                  page={taskPage}
                  total={runs?.total ?? 0}
                  setPage={setTaskPage}
                />
              </CardFooter>
            )}
          </Card>
        </div>
      ) : (
        <TaskSettingsForm
          actionsTarget={actionsTarget}
          key={formVersion}
          saved={view}
          onSaved={() => {
            void load();
          }}
          onUnauthorized={onUnauthorized}
        />
      )}
    </div>
  );
}
function Pager({
  page,
  total,
  setPage,
}: {
  page: number;
  total: number;
  setPage: (page: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button
        size="sm"
        variant="outline"
        disabled={page <= 1}
        onClick={() => setPage(page - 1)}
      >
        Previous
      </Button>
      <span className="text-sm text-muted-foreground">
        Page {page} of {Math.max(1, Math.ceil(total / 10))}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={page * 10 >= total}
        onClick={() => setPage(page + 1)}
      >
        Next
      </Button>
    </div>
  );
}
