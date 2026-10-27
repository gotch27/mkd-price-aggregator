"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  SkipForward,
  Undo2,
  ExternalLink,
  LoaderCircle,
  ListChecks,
} from "lucide-react";
import { toast } from "sonner";
import type {
  CategoryReviewItem,
  CategoryReviewPage,
  CategoryReviewStatus,
} from "@/nextsignal/domain/category-review";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { readableProductText } from "@/nextsignal/domain/product-text";
import { cn } from "@/lib/utils";
import { ProductName } from "./product-name";
import { AgentCategoryReview } from "./agent-category-review";
import { StoreLogo } from "./store-logo";
import { AvailabilityBadge } from "./availability-badge";
import { taskApi } from "./task-api";
import { saveCategoryChoice } from "./category-actions";
import { storeNames, storeName, number, label } from "./types";

const percent = (value: number | null) =>
  value === null
    ? "No score"
    : `${(value * 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}%`;
type UndoReview = { item: CategoryReviewItem; snapshot: string };

export function CategoryReview({
  pageSize,
  debounceMs,
  onUnauthorized,
  onProduct,
  onChanged,
  update,
}: {
  pageSize: number;
  debounceMs: number;
  onUnauthorized: () => void;
  onProduct: (id: string) => void;
  onChanged: () => void;
  update: number;
}) {
  const fieldId = useId();
  const [status, setStatus] = useState<CategoryReviewStatus>("needs_review"),
    [retailer, setRetailer] = useState("all"),
    [draft, setDraft] = useState(""),
    [search, setSearch] = useState(""),
    [includeUnavailable, setIncludeUnavailable] = useState(false),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const [data, setData] = useState<CategoryReviewPage | null>(null),
    [active, setActive] = useState<CategoryReviewItem | null>(null),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [undo, setUndo] = useState<UndoReview | null>(null),
    [sessionCount, setSessionCount] = useState(0);
  const preferred = useRef<string | null>(null),
    request = useRef<AbortController | null>(null),
    inFlight = useRef(false),
    productTitle = useRef<HTMLDivElement | null>(null);
  const scope = `${status}:${retailer}:${search}:${includeUnavailable}:${page}`;
  const scopeRef = useRef(scope);
  const loadedScope = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    productTitle.current?.scrollIntoView({ block: "nearest" });
  }, [active?.id]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(draft);
      setPage(1);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [draft, debounceMs]);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    const captured = scope;
    const query = new URLSearchParams({
      status,
      search,
      availability: includeUnavailable ? "all" : "available",
      page: String(page),
      size: String(pageSize),
    });
    if (retailer !== "all") query.set("retailer", retailer);
    try {
      const result = await taskApi<CategoryReviewPage>(
        `/api/review/categories?${query}`,
        onUnauthorized,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || scopeRef.current !== captured) return;
      const selected = preferred.current;
      preferred.current = null;
      setData(result);
      setActive((previous) =>
        selected === "end"
          ? null
          : (result.rows.find((row) => row.id === (selected ?? previous?.id)) ??
            result.rows[0] ??
            null),
      );
      if (result.page !== page) setPage(result.page);
    } catch (e) {
      if (!controller.signal.aborted && scopeRef.current === captured)
        setError(
          e instanceof Error ? e.message : "Could not load review products",
        );
    } finally {
      if (!controller.signal.aborted && scopeRef.current === captured)
        setLoading(false);
    }
  }, [
    scope,
    status,
    search,
    includeUnavailable,
    page,
    pageSize,
    retailer,
    onUnauthorized,
  ]);
  useEffect(() => {
    if (loadedScope.current !== scope) {
      setActive(null);
      setData(null);
      preferred.current = null;
      loadedScope.current = scope;
    }
    void load();
    return () => request.current?.abort();
  }, [load, revision, update, scope]);
  const busy = loading || saving || !!error;
  function refresh(nextId?: string) {
    preferred.current = nextId ?? null;
    setRevision((v) => v + 1);
  }
  async function choose(category?: string) {
    if (!active || inFlight.current || busy) return;
    if (
      category === undefined &&
      ["assigned", "agent"].includes(active.classification.state)
    )
      category = active.classification.category ?? undefined;
    if (category === undefined && !active.classification.can_accept_suggestion)
      return;
    const item = active,
      index = data?.rows.findIndex((row) => row.id === item.id) ?? -1,
      next = data?.rows[index + 1];
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await saveCategoryChoice(
        {
          id: item.product_id,
          member_id: item.id,
          snapshot: item.classification.snapshot,
          action: category === undefined ? "accept_suggestion" : "set",
          category: category ?? null,
          note: "",
        },
        onUnauthorized,
      );
      setUndo({ item, snapshot: result.classification.snapshot });
      setSessionCount((n) => n + 1);
      onChanged();
      if (next) {
        setActive(next);
        refresh(next.id);
      } else if (
        (status === "all" || status === "reviewed") &&
        data &&
        page < data.total_pages
      )
        setPage((p) => p + 1);
      else if (status === "all" || status === "reviewed") {
        setActive(null);
        preferred.current = "end";
        setRevision((v) => v + 1);
      } else refresh();
    } catch (e) {
      refresh(item.id);
      toast.error("Category was not saved", {
        description: e instanceof Error ? e.message : "Try again.",
      });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  async function undoLast() {
    if (!undo || inFlight.current || busy) return;
    inFlight.current = true;
    setSaving(true);
    try {
      const before = undo.item.classification.manual_category;
      await saveCategoryChoice(
        {
          id: undo.item.product_id,
          member_id: undo.item.id,
          snapshot: undo.snapshot,
          action: before === null ? "reset" : "set",
          category: before,
          note: "Undo manual review choice",
        },
        onUnauthorized,
      );
      refresh(undo.item.id);
      setUndo(null);
      setSessionCount((n) => Math.max(0, n - 1));
      onChanged();
      toast.success("Previous category restored");
    } catch (e) {
      toast.error("Could not undo", {
        description:
          e instanceof Error ? e.message : "The product may have changed.",
      });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  function skip() {
    if (!active || busy || !data) return;
    const index = data.rows.findIndex((row) => row.id === active.id),
      next = data.rows[index + 1];
    if (next) setActive(next);
    else if (page < data.total_pages) setPage((p) => p + 1);
    else {
      setActive(null);
      toast.info("End of this list", {
        description:
          "Skipped products remain waiting. Refresh to return to them.",
      });
    }
  }
  const actions = useRef({ choose, skip, busy, active });
  actions.current = { choose, skip, busy, active };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        actions.current.busy
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(
          'input,textarea,select,[role="combobox"],[role="dialog"],[role="listbox"],[contenteditable="true"]',
        )
      )
        return;
      if (
        event.key === "Enter" &&
        target instanceof HTMLElement &&
        target.closest("button,a")
      )
        return;
      if (event.key === "Enter") {
        event.preventDefault();
        void actions.current.choose();
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        actions.current.skip();
      } else if (/^[1-9]$/.test(event.key)) {
        const option =
          actions.current.active?.classification.options[Number(event.key) - 1];
        if (option) {
          event.preventDefault();
          void actions.current.choose(option.category);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const choices = active?.classification.options ?? [],
    suggested = active?.classification.suggested_category,
    selectedCategory =
      active &&
      ["manual", "agent", "assigned"].includes(active.classification.state)
        ? active.classification.category
        : null;
  return (
    <div className="flex flex-col gap-4">
      <AgentCategoryReview
        retailer={retailer}
        search={search}
        onUnauthorized={onUnauthorized}
        onChanged={() => {
          onChanged();
          refresh();
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          value={status}
          disabled={saving}
          aria-label="Products to review"
          onValueChange={(value) => {
            if (value) {
              preferred.current = null;
              setStatus(value as CategoryReviewStatus);
              setPage(1);
            }
          }}
          className="flex-wrap"
        >
          {[
            ["needs_review", "Needs review"],
            ["assigned", "Decision model"],
            ["agent", "Agent"],
            ["reviewed", "Human"],
            ["all", "All labeled"],
          ].map(([value, title]) => (
            <ToggleGroupItem key={value} value={value}>
              {title}
              <span className="tabular-nums text-muted-foreground">
                {data
                  ? number(
                      data.counts[
                        value === "all"
                          ? "total"
                          : (value as keyof CategoryReviewPage["counts"])
                      ],
                    )
                  : "—"}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {number(sessionCount)} reviewed this session
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!undo || busy}
            onClick={() => void undoLast()}
          >
            <Undo2 data-icon="inline-start" />
            Undo
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Refresh review queue"
            disabled={loading || saving}
            onClick={() => refresh(active?.id)}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      <FieldGroup className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto]">
        <Field>
          <FieldLabel htmlFor={`${fieldId}-store`}>Store</FieldLabel>
          <Select
            value={retailer}
            disabled={saving}
            onValueChange={(value) => {
              setRetailer(value);
              setPage(1);
              preferred.current = null;
            }}
          >
            <SelectTrigger id={`${fieldId}-store`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">All stores</SelectItem>
                {Object.entries(storeNames).map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${fieldId}-search`}>Find a product</FieldLabel>
          <Input
            id={`${fieldId}-search`}
            value={draft}
            disabled={saving}
            placeholder="Search product names…"
            onChange={(event) => setDraft(event.target.value)}
          />
        </Field>
        <Field orientation="horizontal" className="self-end pb-2">
          <Checkbox
            id={`${fieldId}-stock`}
            checked={includeUnavailable}
            disabled={saving}
            onCheckedChange={(value) => {
              setIncludeUnavailable(value === true);
              setPage(1);
              preferred.current = null;
            }}
          />
          <FieldLabel htmlFor={`${fieldId}-stock`}>
            Include unavailable
          </FieldLabel>
        </Field>
      </FieldGroup>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Review could not be loaded</AlertTitle>
          <AlertDescription>
            {error}
            <Button variant="outline" size="sm" onClick={() => refresh()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <Card className="hidden lg:flex">
          <CardHeader>
            <CardTitle>Categorization</CardTitle>
            <CardDescription>
              {data
                ? `${number(data.total)} products in this view`
                : "Loading products…"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex max-h-[30rem] flex-col gap-1 overflow-auto">
            {data?.rows.map((row) => (
              <Button
                key={row.id}
                variant={active?.id === row.id ? "secondary" : "ghost"}
                className="h-auto justify-start whitespace-normal p-2 text-left"
                disabled={busy}
                onClick={() => setActive(row)}
              >
                <span className="flex flex-col gap-1">
                  <ProductName name={row.name} retailer={row.retailer} />
                  <span className="text-xs text-muted-foreground">
                    {storeName(row.retailer)}
                    {row.classification.suggested_category &&
                      ` · ${label(row.classification.suggested_category)}`}
                  </span>
                </span>
              </Button>
            ))}
          </CardContent>
          <CardFooter className="justify-between gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous review page"
              disabled={busy || page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft />
            </Button>
            <span className="text-xs text-muted-foreground">
              {data ? `${data.page} / ${Math.max(1, data.total_pages)}` : "—"}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next review page"
              disabled={busy || !data || page >= data.total_pages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight />
            </Button>
          </CardFooter>
        </Card>
        <div className="flex min-w-0 flex-col gap-3">
          {loading && !active ? (
            <Card>
              <CardContent className="flex flex-col gap-4">
                <Skeleton className="h-8" />
                <Skeleton className="h-20" />
                <Skeleton className="h-56" />
              </CardContent>
            </Card>
          ) : active ? (
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <StoreLogo slug={active.retailer} />
                  <CardDescription>
                    {storeName(active.retailer)} · Categorization
                  </CardDescription>
                  <AvailabilityBadge value={active.availability} />
                </div>
                <CardTitle ref={productTitle}>
                  <ProductName
                    name={active.name}
                    retailer={active.retailer}
                    showSource
                  />
                </CardTitle>
                <CardAction>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Open product details"
                    onClick={() => onProduct(active.product_id)}
                  >
                    <ExternalLink />
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {(active.description || active.source_category) && (
                  <p className="text-sm text-muted-foreground">
                    {[active.description, active.source_category]
                      .filter(Boolean)
                      .map((text) =>
                        readableProductText(text!, active.retailer),
                      )
                      .join(" · ")}
                  </p>
                )}
                {Object.keys(active.facts).length > 0 && (
                  <dl className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                    {[
                      "brand",
                      "quantity",
                      "unit",
                      "pack",
                      "variant",
                      "model",
                      "size",
                    ]
                      .filter((key) => active.facts[key])
                      .map((key) => (
                        <div key={key}>
                          <dt className="text-xs text-muted-foreground">
                            {label(key)}
                          </dt>
                          <dd>{active.facts[key]}</dd>
                        </div>
                      ))}
                  </dl>
                )}
                <Separator />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    {["manual", "agent"].includes(
                      active.classification.state,
                    ) ? (
                      <p>
                        {active.classification.source === "agent"
                          ? "Agent selected"
                          : "Human confirmed"}
                        :{" "}
                        <strong>
                          {label(active.classification.category ?? "unknown")}
                        </strong>
                      </p>
                    ) : suggested && suggested !== "unknown" ? (
                      <p>
                        {active.classification.state === "assigned"
                          ? "AI assigned"
                          : "Suggested"}
                        : <strong>{label(suggested)}</strong>{" "}
                        <span className="text-muted-foreground">
                          {percent(active.classification.probability)}
                        </span>
                      </p>
                    ) : (
                      <p>No clear suggestion</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {active.classification.state === "outdated"
                        ? "Product information changed. Choose a category after checking the current details."
                        : active.classification.can_accept_suggestion
                          ? `Below the ${percent(active.classification.threshold)} automatic threshold. Confirm it or choose another category.`
                          : "Choose a category to confirm or correct it."}
                    </p>
                    {active.classification.review_reason && (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {active.classification.review_reason}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(active.classification.can_accept_suggestion ||
                      ["assigned", "agent"].includes(
                        active.classification.state,
                      )) && (
                      <Button disabled={busy} onClick={() => void choose()}>
                        {saving ? (
                          <LoaderCircle
                            className="animate-spin"
                            data-icon="inline-start"
                          />
                        ) : (
                          <Check data-icon="inline-start" />
                        )}
                        {["assigned", "agent"].includes(
                          active.classification.state,
                        )
                          ? "Confirm category"
                          : "Accept suggestion"}
                      </Button>
                    )}
                    <Button variant="outline" disabled={busy} onClick={skip}>
                      Skip
                      <SkipForward data-icon="inline-end" />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">
                    Or choose a category. Model scores are shown highest first.
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                    {choices.map((option, index) => {
                      const selected = selectedCategory === option.category;
                      return (
                        <Button
                          key={option.category}
                          variant={selected ? "default" : "outline"}
                          aria-pressed={selected}
                          className="h-auto min-h-11 justify-between gap-2 whitespace-normal px-3 py-2 text-left"
                          disabled={busy}
                          onClick={() => void choose(option.category)}
                          aria-label={`Choose ${option.label}${option.probability !== null ? `, model score ${percent(option.probability)}` : ""}`}
                        >
                          <span>{option.label}</span>
                          <span className="flex shrink-0 flex-col items-end">
                            <span
                              className={cn(
                                "tabular-nums",
                                !selected && "text-muted-foreground",
                              )}
                            >
                              {percent(option.probability)}
                            </span>
                            {(selected || index < 9) && (
                              <span
                                className={cn(
                                  "flex items-center gap-1 text-xs",
                                  !selected && "text-muted-foreground",
                                )}
                              >
                                {selected && (
                                  <Check
                                    data-icon="inline-end"
                                    aria-hidden="true"
                                  />
                                )}
                                {index < 9 && index + 1}
                              </span>
                            )}
                          </span>
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex-wrap justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Click saves and moves on · Enter accepts · 1–9 chooses · N
                  skips
                </p>
                <p aria-live="polite" className="text-xs text-muted-foreground">
                  {saving
                    ? "Saving category…"
                    : "Manual choices are logged. No AI request is used to save them."}
                </p>
              </CardFooter>
            </Card>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ListChecks />
                </EmptyMedia>
                <EmptyTitle>
                  {data?.total ? "End of this list" : "No products to review"}
                </EmptyTitle>
                <EmptyDescription>
                  {data?.total
                    ? "Skipped products are still waiting. Refresh or choose another page."
                    : "Try another store or view. New uncertain classifications will appear here when you refresh."}
                </EmptyDescription>
              </EmptyHeader>
              {!!data?.total && (
                <Button variant="outline" onClick={() => refresh()}>
                  Return to waiting products
                </Button>
              )}
            </Empty>
          )}
          <div className="flex items-center justify-between gap-3 lg:hidden">
            <Button
              variant="outline"
              disabled={busy || page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft data-icon="inline-start" />
              Previous page
            </Button>
            <span className="text-xs text-muted-foreground">
              {data ? `${data.page} / ${Math.max(1, data.total_pages)}` : "—"}
            </span>
            <Button
              variant="outline"
              disabled={busy || !data || page >= data.total_pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next page
              <ChevronRight data-icon="inline-end" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
