"use client";
import { useEffect, useState } from "react";
import { History } from "lucide-react";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { taskApi } from "./task-api";
import { taskSettingLabels, settingValue } from "./task-labels";
type Entry = {
  revision: number;
  actor: string;
  created_at: string;
  changes: { field: string; before: unknown; after: unknown }[];
};
type Page = { rows: Entry[]; total: number; page: number; size: number };
export function TaskSettingsHistory({
  revision,
  timezone,
  onUnauthorized,
}: {
  revision: number;
  timezone: string;
  onUnauthorized: () => void;
}) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(1),
    [data, setData] = useState<Page | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void taskApi<Page>(
      `/api/task-settings/history?page=${page}&size=10`,
      onUnauthorized,
      { signal: abort.signal },
    )
      .then((result) => {
        if (!abort.signal.aborted) setData(result);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [open, page, revision, reload, onUnauthorized]);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm">
          <History data-icon="inline-start" />
          History
        </Button>
      </SheetTrigger>
      <SheetContent className="settings-history-sheet">
        <SheetHeader>
          <SheetTitle>Settings history</SheetTitle>
          <SheetDescription>
            Who changed what, and when. Saved matches and spending records stay
            intact.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn’t load history</AlertTitle>
              <AlertDescription>
                {error}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setReload((v) => v + 1)}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : loading ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : data?.rows.length ? (
            <div className="settings-history-entries">
              {data.rows.map((entry) => (
                <section key={entry.revision}>
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Badge variant="outline">Revision {entry.revision}</Badge>
                    <span className="text-sm text-muted-foreground">
                      {entry.actor} ·{" "}
                      {new Date(entry.created_at).toLocaleString("en-GB", {
                        timeZone: timezone,
                      })}
                    </span>
                  </div>
                  <dl className="detail-fields">
                    {entry.changes.map((change) => (
                      <div key={change.field}>
                        <dt>
                          {taskSettingLabels[change.field] ??
                            change.field.replaceAll("_", " ")}
                        </dt>
                        <dd>
                          {settingValue(change.field, change.before)} →{" "}
                          {settingValue(change.field, change.after)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No changes yet</EmptyTitle>
                <EmptyDescription>
                  Your deployment defaults are still active.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <SheetFooter className="flex-row items-center justify-between border-t">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {Math.max(1, Math.ceil((data?.total ?? 0) / 10))}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={loading || !data || page * 10 >= data.total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
