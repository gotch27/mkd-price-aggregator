"use client";
import { useCallback, useRef, useState, type FormEvent } from "react";
import { Link2, Store, Layers3, CircleAlert } from "lucide-react";
import { toast } from "sonner";
import { CategoryReview } from "./_components/dashboard/category-review";
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Status as StatusLegend } from "@/app/_components/dashboard/status";
import { Login } from "@/app/_components/dashboard/login";
import { Overview } from "@/app/_components/dashboard/overview";
import { ObservabilityTabs } from "./_components/dashboard/observability-tabs";
import { Navigation } from "@/app/_components/dashboard/navigation";
import { StoreBrowser } from "@/app/_components/dashboard/store-browser";
import { StoreLogo } from "@/app/_components/dashboard/store-logo";
import { Filters } from "@/app/_components/dashboard/filters";
import { Tasks } from "@/app/_components/dashboard/tasks";
import { TaskReview } from "@/app/_components/dashboard/task-review";
import { RecordsTable } from "@/app/_components/dashboard/records-table";
import {
  DetailSheet,
  type DetailSelection,
} from "@/app/_components/dashboard/detail-sheet";
import { useDashboardData } from "@/app/_components/dashboard/use-dashboard-data";
import { useNavigation } from "@/app/_components/dashboard/use-navigation";
import {
  views,
  storeName,
  text,
  type Row,
  type DashboardView,
  type TaskRequest,
} from "@/app/_components/dashboard/types";
import type {
  DashboardQuery,
  NameQuality,
} from "@/nextsignal/domain/dashboard";
export default function Dashboard({
  authenticated,
  pageSize,
  timezone,
  refreshMs,
  debounceMs,
  autoRefreshViews,
  initialNameQuality,
  initialAvailability,
}: {
  authenticated: boolean;
  pageSize: number;
  timezone: string;
  refreshMs: number;
  debounceMs: number;
  autoRefreshViews: DashboardView[];
  initialNameQuality: NameQuality;
  initialAvailability: NonNullable<DashboardQuery["availability"]>;
}) {
  const [signedIn, setSignedIn] = useState(authenticated);
  const {
    state: nav,
    go,
    navigate,
  } = useNavigation(initialNameQuality, initialAvailability);
  const [actionError, setError] = useState("");
  const [pendingAction, setPendingAction] = useState(false);
  const actionInFlight = useRef(false);
  const [reviewTask, setReviewTask] = useState<TaskRequest | null>(null);
  const [taskUpdate, setTaskUpdate] = useState<{
    revision: number;
    createdId: string | null;
  }>({ revision: 0, createdId: null });
  const [retryDraft, setRetryDraft] = useState<Row | null>(null);
  const [detail, setDetail] = useState<DetailSelection | null>(null);
  const [categoryReviewUpdate, setCategoryReviewUpdate] = useState(0);
  const [pageActions, setPageActions] = useState<HTMLDivElement | null>(null);
  const onUnauthorized = useCallback(() => setSignedIn(false), []);
  const date = (value: unknown) =>
    value
      ? new Date(String(value)).toLocaleString("en-GB", {
          timeZone: timezone,
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "Not yet";
  const view: DashboardView =
    nav.screen === "overview" ||
    nav.screen === "tasks" ||
    nav.screen === "settings" ||
    nav.screen === "review"
      ? "summary"
      : nav.screen === "observability"
        ? nav.tab === "logs"
          ? "logs"
          : "runs"
        : nav.mode === "all"
          ? "universal"
          : nav.source_id
            ? "products"
            : nav.retailer
              ? "sources"
              : "summary";
  const query: DashboardQuery = { ...nav, view, size: pageSize };
  const common = { refreshMs, debounceMs, autoRefreshViews, setSignedIn };
  const overview = useDashboardData({
    ...common,
    signedIn,
    query: { view: "summary", search: "", page: 1, size: pageSize },
  });
  const data = useDashboardData({
    ...common,
    signedIn: signedIn && view !== "summary",
    query,
  });
  const busy = data.loading;
  const error = actionError || data.error || overview.error;
  const change = (patch: Partial<DashboardQuery>) => {
    go({ ...patch, page: 1 }, !!(patch.search !== undefined));
  };
  async function startTask() {
    if (!reviewTask || actionInFlight.current) return;
    actionInFlight.current = true;
    setPendingAction(true);
    try {
      const response = await fetch(reviewTask.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reviewTask.body),
      });
      if (response.status === 401) {
        setReviewTask(null);
        setSignedIn(false);
        return;
      }
      const r = await response.json();
      if (!response.ok || !r.ok)
        throw new Error(r.errors?.[0]?.message ?? "Request failed");
      setTaskUpdate((previous) => ({
        revision: previous.revision + 1,
        createdId:
          reviewTask.endpoint === "/api/tasks" ? r.data.id : previous.createdId,
      }));
      toast.success("Request received", {
        description: reviewTask.successMessage,
        action: { label: "View Run Tasks", onClick: () => navigate("tasks") },
      });
      if (reviewTask.endpoint === "/api/retry") setRetryDraft(null);
      setReviewTask(null);
      data.refresh();
      overview.refresh();
    } catch (e) {
      toast.error("Request could not be completed", {
        description:
          e instanceof TypeError
            ? "Could not confirm the request. Check Observability → Data updates before trying again."
            : e instanceof Error
              ? e.message
              : String(e),
      });
    } finally {
      actionInFlight.current = false;
      setPendingAction(false);
    }
  }
  const retry = (row: Row) => {
    setDetail(null);
    setRetryDraft(row);
    navigate("tasks");
  };
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const form = new FormData(event.currentTarget);
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(form)),
      });
      if (response.ok) setSignedIn(true);
      else {
        const result: { message?: unknown } | null = await response
          .json()
          .catch(() => null);
        setError(
          typeof result?.message === "string"
            ? result.message
            : "Sign-in is temporarily unavailable. Please try again shortly.",
        );
      }
    } catch {
      setError("Unable to connect. Please try again.");
    }
  }
  if (!signedIn) return <Login error={actionError} onSubmit={login} />;
  const page = data.page;
  const isProducts = nav.screen === "products";
  const scoped = isProducts && nav.mode === "stores";
  const sourceName = nav.source_name ?? "Catalog";
  function open(row: Row) {
    if (view === "sources") {
      go({
        source_id: text(row.id),
        source_name: text(row.name),
        page: 1,
        search: "",
      });
      return;
    }
    setDetail({
      kind: view === "runs" ? "update" : view === "logs" ? "log" : "product",
      row,
    });
  }
  const headerTitle =
    isProducts && scoped && nav.source_id
      ? sourceName
      : isProducts && scoped && nav.retailer
        ? storeName(nav.retailer)
        : views[nav.screen].label;
  const records = view !== "summary" && (
    <div className="flex flex-col gap-4">
      <Filters
        query={query}
        busy={busy}
        onChange={change}
        onRefresh={data.refresh}
      />
      {view === "universal" && (
        <div className="section-context">
          <Link2 className="size-4" />
          <span>
            One row per universal product. Open Details to see its store
            products and why they match.
          </span>
        </div>
      )}
      {view === "products" && page?.refresh_pending && (
        <Alert>
          <AlertTitle>New catalog data is being indexed</AlertTitle>
          <AlertDescription>
            These results show the last completed browser index, updated{" "}
            {date(page.refreshed_at)}.
          </AlertDescription>
        </Alert>
      )}
      {view === "logs" && (
        <div className="log-legend">
          <span>Log levels</span>
          {["debug", "info", "warn", "error"].map((v) => (
            <StatusLegend key={v} value={v} />
          ))}
        </div>
      )}
      <RecordsTable
        view={view}
        rows={page?.rows ?? []}
        date={date}
        page={page?.page ?? nav.page}
        pageSize={pageSize}
        busy={busy}
        total={page?.total ?? null}
        totalPages={page?.total_pages ?? null}
        onDetails={open}
        onRetry={retry}
        onPageChange={(p) => go({ page: p })}
      />
    </div>
  );
  return (
    <TooltipProvider>
      <SidebarProvider className="workspace">
        <Navigation
          screen={nav.screen}
          onNavigate={(screen) => {
            setDetail(null);
            setError("");
            navigate(screen);
          }}
          onLogout={() => {
            void (async () => {
              try {
                const r = await fetch("/api/auth/logout", { method: "POST" });
                if (!r.ok) throw new Error("Unable to sign out");
                setSignedIn(false);
                setDetail(null);
              } catch (e) {
                setError(String(e));
              }
            })();
          }}
        />
        <SidebarInset className="workspace-main">
          <div className="workspace-topbar">
            <div className="flex min-w-0 items-center gap-3">
              <SidebarTrigger />
              <Separator orientation="vertical" className="h-4" />
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      <button
                        onClick={() =>
                          nav.screen === "products"
                            ? go({
                                retailer: undefined,
                                source_id: undefined,
                                source_name: undefined,
                                page: 1,
                                search: "",
                              })
                            : navigate(nav.screen)
                        }
                      >
                        {views[nav.screen].label}
                      </button>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  {isProducts && scoped && nav.retailer && (
                    <>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        {nav.source_id ? (
                          <BreadcrumbLink asChild>
                            <button
                              onClick={() =>
                                go({
                                  source_id: undefined,
                                  source_name: undefined,
                                  page: 1,
                                  search: "",
                                })
                              }
                            >
                              {storeName(nav.retailer)}
                            </button>
                          </BreadcrumbLink>
                        ) : (
                          <BreadcrumbPage>
                            {storeName(nav.retailer)}
                          </BreadcrumbPage>
                        )}
                      </BreadcrumbItem>
                    </>
                  )}
                  {isProducts && scoped && nav.source_id && (
                    <>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbPage className="max-w-48 truncate">
                          {sourceName}
                        </BreadcrumbPage>
                      </BreadcrumbItem>
                    </>
                  )}
                </BreadcrumbList>
              </Breadcrumb>
            </div>
          </div>
          <div className="workspace-scroll">
            <div className="page-content">
              <header className="page-heading">
                <div className="flex items-center gap-4">
                  {isProducts && scoped && nav.retailer && (
                    <StoreLogo slug={nav.retailer} large />
                  )}
                  <div>
                    <h1>{headerTitle}</h1>
                    <p>
                      {isProducts && scoped && nav.source_id
                        ? "Published products and prices in this catalog."
                        : isProducts && scoped && nav.retailer
                          ? "Choose a catalog to explore this store’s products."
                          : views[nav.screen].description}
                    </p>
                  </div>
                </div>
                {(nav.screen === "tasks" || nav.screen === "settings") && (
                  <div ref={setPageActions} className="page-actions" />
                )}
              </header>
              {error && (
                <Alert variant="destructive">
                  <CircleAlert />
                  <AlertTitle>Something needs attention</AlertTitle>
                  <AlertDescription>
                    {error}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setError("");
                        data.refresh();
                        overview.refresh();
                      }}
                    >
                      Try again
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              {nav.screen === "overview" && (
                <Overview summary={overview.summary} />
              )}
              {nav.screen === "review" && (
                <CategoryReview
                  pageSize={pageSize}
                  debounceMs={debounceMs}
                  update={categoryReviewUpdate}
                  onUnauthorized={onUnauthorized}
                  onProduct={(id) =>
                    setDetail({ kind: "product", row: { id, product_id: id } })
                  }
                  onChanged={() => {
                    overview.refresh();
                    data.refresh();
                  }}
                />
              )}
              {(nav.screen === "tasks" || nav.screen === "settings") && (
                <Tasks
                  key={nav.screen}
                  section={nav.screen === "settings" ? "settings" : "run"}
                  actionsTarget={pageActions}
                  update={taskUpdate}
                  refreshMs={refreshMs}
                  pageSize={pageSize}
                  retry={retryDraft}
                  onReview={(task) => {
                    setReviewTask(task);
                  }}
                  onDismissRetry={() => setRetryDraft(null)}
                  onUpdates={() => navigate("observability", "updates")}
                  onProduct={(id) =>
                    setDetail({ kind: "product", row: { id, product_id: id } })
                  }
                  onUnauthorized={onUnauthorized}
                />
              )}
              {isProducts && (
                <div className="product-toolbar">
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={nav.mode}
                    aria-label="Product browsing mode"
                    onValueChange={(mode) => {
                      if (mode)
                        go({
                          mode: mode as "stores" | "all",
                          retailer: undefined,
                          source_id: undefined,
                          source_name: undefined,
                          page: 1,
                          search: "",
                          match_filter: "all",
                        });
                    }}
                  >
                    <ToggleGroupItem value="stores">
                      <Store data-icon="inline-start" />
                      By store
                    </ToggleGroupItem>
                    <ToggleGroupItem value="all">
                      <Layers3 data-icon="inline-start" />
                      All products
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <p>
                    {nav.mode === "all"
                      ? "Universal products and their connected store listings."
                      : "Browse stores, then catalogs, then products."}
                  </p>
                  {scoped && nav.retailer && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        go({
                          retailer: undefined,
                          source_id: undefined,
                          source_name: undefined,
                          page: 1,
                          search: "",
                        })
                      }
                    >
                      All stores
                    </Button>
                  )}
                </div>
              )}
              {isProducts && scoped && !nav.retailer && (
                <StoreBrowser
                  summary={overview.summary}
                  date={date}
                  onStore={(retailer) =>
                    go({
                      retailer,
                      source_id: undefined,
                      source_name: undefined,
                      page: 1,
                      search: "",
                    })
                  }
                />
              )}
              {nav.screen === "observability" ? (
                <ObservabilityTabs
                  tab={nav.tab ?? "updates"}
                  onChange={(tab) => {
                    setDetail(null);
                    setError("");
                    navigate("observability", tab);
                  }}
                >
                  {records}
                </ObservabilityTabs>
              ) : (
                records
              )}
            </div>
          </div>
        </SidebarInset>
        <DetailSheet
          selection={detail}
          date={date}
          pageSize={pageSize}
          onClose={() => setDetail(null)}
          onProductChanged={() => {
            data.refresh();
            overview.refresh();
            setCategoryReviewUpdate((revision) => revision + 1);
          }}
          onRetry={retry}
          onLogs={(id) => {
            setDetail(null);
            go({
              screen: "observability",
              tab: "logs",
              run_id: id,
              source_id: undefined,
              source_name: undefined,
              kind: undefined,
              status: undefined,
              correlation_id: undefined,
              retailer: undefined,
              search: "",
              level: undefined,
              page: 1,
            });
          }}
          onUnauthorized={onUnauthorized}
        />
        <TaskReview
          task={reviewTask}
          pending={pendingAction}
          onClose={() => {
            setReviewTask(null);
          }}
          onConfirm={() => void startTask()}
        />
      </SidebarProvider>
    </TooltipProvider>
  );
}
