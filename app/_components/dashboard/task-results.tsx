"use client";
import { MatchingTaskResults } from "./matching-task-results";
import { useEffect, useRef, useState } from "react";
import {
  ListChecks,
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { TaskResultsPage } from "@/nextsignal/domain/task-results";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "@/components/ui/input-group";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { taskApi } from "./task-api";
import { storeName, number } from "./types";
import { ProductCategoryEditor } from "./product-category-editor";
import { ProductName } from "./product-name";
import { QuickCategoryApproval } from "./category-quick-accept";
import { readableProductCategory } from "@/nextsignal/domain/product-text";

const categoryName = (id: string | null) =>
  id
    ? id.replaceAll("_", " ").replace(/^./, (s) => s.toUpperCase())
    : "Not saved";
const percent = (value: number) =>
  `${(value * 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}%`;
function CategoryTaskResults({
  id,
  updatedAt,
  pageSize,
  onUnauthorized,
  onProduct,
  onCategoryChanged,
}: {
  id: string;
  updatedAt: string;
  pageSize: number;
  onUnauthorized: () => void;
  onProduct: (id: string) => void;
  onCategoryChanged: () => void;
}) {
  const openingProduct = useRef(false);
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(1),
    [draft, setDraft] = useState(""),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState("all"),
    [outcome, setOutcome] = useState("all"),
    [reload, setReload] = useState(0);
  const [data, setData] = useState<TaskResultsPage | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    const query = new URLSearchParams({
      page: String(page),
      size: String(pageSize),
      search,
      category: category === "all" ? "" : category,
      outcome: outcome === "all" ? "" : outcome,
    });
    void taskApi<TaskResultsPage>(
      `/api/tasks/${id}/results?${query}`,
      onUnauthorized,
      { signal: abort.signal },
    )
      .then((result) => {
        if (!abort.signal.aborted) {
          setData(result);
          if (result.page !== page) setPage(result.page);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load results");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [
    open,
    id,
    page,
    pageSize,
    search,
    category,
    outcome,
    reload,
    updatedAt,
    onUnauthorized,
  ]);
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          setPage(1);
          setSearch("");
          setDraft("");
          setCategory("all");
          setOutcome("all");
        }
      }}
    >
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <ListChecks data-icon="inline-start" />
          View results
        </Button>
      </SheetTrigger>
      <SheetContent
        className="task-results-sheet"
        onCloseAutoFocus={(event) => {
          if (openingProduct.current) {
            event.preventDefault();
            openingProduct.current = false;
          }
        }}
      >
        <SheetHeader>
          <SheetTitle>Categorization results</SheetTitle>
          <SheetDescription>
            Products checked by this task, their saved categories, and answers
            that need review. Viewing results makes no AI calls.
          </SheetDescription>
          {data && (
            <div className="flex flex-wrap gap-2 pt-2">
              <Badge variant="secondary">
                {data.task.stores.map(storeName).join(", ")}
              </Badge>
              <Badge variant="outline">{data.task.state}</Badge>
              <Badge variant="success">
                {number(data.summary.assigned)} assigned
              </Badge>
              <Badge
                variant={data.summary.needs_review ? "warning" : "secondary"}
              >
                {number(data.summary.needs_review)} need review
              </Badge>
              {data.summary.reviewed > 0 && (
                <Badge variant="info">
                  {number(data.summary.reviewed)} reviewed
                </Badge>
              )}
              {data.summary.skipped > 0 && (
                <Badge variant="secondary">
                  {number(data.summary.skipped)} skipped
                </Badge>
              )}
              {data.summary.deferred > 0 && (
                <Badge variant="warning">
                  {number(data.summary.deferred)} deferred
                </Badge>
              )}
              <Badge variant="outline">
                ${Number(data.task.spending_usd).toFixed(4)} ·{" "}
                {number(data.task.requests)} requests
              </Badge>
            </div>
          )}
        </SheetHeader>
        {data && ["paused", "failed", "cooldown"].includes(data.task.state) && (
          <div className="px-4">
            <Alert>
              <AlertTitle>
                {data.task.state === "cooldown"
                  ? "Waiting for Gateway recovery"
                  : data.task.state === "paused"
                    ? "Task paused"
                    : "Task stopped"}
              </AlertTitle>
              <AlertDescription>
                {data.task.reason} Saved results stay available below.
              </AlertDescription>
            </Alert>
          </div>
        )}
        <form
          className="px-4"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(draft);
            setPage(1);
          }}
        >
          <FieldGroup className="sm:flex-row sm:items-end">
            <Field className="flex-1">
              <FieldLabel htmlFor={`result-search-${id}`}>
                Find a product
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id={`result-search-${id}`}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Search the product names…"
                />
                <InputGroupAddon align="inline-end">
                  <Button type="submit" variant="ghost" size="sm">
                    <Search data-icon="inline-start" />
                    Search
                  </Button>
                </InputGroupAddon>
              </InputGroup>
            </Field>
            <Field className="sm:max-w-56">
              <FieldLabel htmlFor={`result-category-${id}`}>
                Current category
              </FieldLabel>
              <Select
                value={category}
                onValueChange={(value) => {
                  setCategory(value);
                  setPage(1);
                }}
              >
                <SelectTrigger id={`result-category-${id}`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All categories</SelectItem>
                    {data?.categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {categoryName(c.id)} ({number(c.count)})
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4">
          <ToggleGroup
            type="single"
            variant="outline"
            value={outcome}
            aria-label="Filter categorization results"
            onValueChange={(value) => {
              if (value) {
                setOutcome(value);
                setPage(1);
              }
            }}
          >
            <ToggleGroupItem value="all">
              All ({data?.summary.total ?? "…"})
            </ToggleGroupItem>
            <ToggleGroupItem value="assigned">Assigned</ToggleGroupItem>
            <ToggleGroupItem value="needs_review">Needs review</ToggleGroupItem>
            <ToggleGroupItem value="reviewed">Reviewed</ToggleGroupItem>
            <ToggleGroupItem value="waiting">Waiting</ToggleGroupItem>
            <ToggleGroupItem value="skipped">Skipped</ToggleGroupItem>
            <ToggleGroupItem value="deferred">Deferred</ToggleGroupItem>
          </ToggleGroup>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setReload((v) => v + 1)}
            disabled={loading}
          >
            <RefreshCw data-icon="inline-start" />
            Refresh results
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4" aria-busy={loading}>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Could not load results</AlertTitle>
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
            <div className="flex flex-col gap-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : data?.rows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Original model probability</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-96 whitespace-normal">
                      <Button
                        variant="link"
                        className="h-auto justify-start whitespace-normal p-0 text-left"
                        onClick={() => {
                          openingProduct.current = true;
                          setOpen(false);
                          onProduct(row.product_id);
                        }}
                      >
                        <ProductName name={row.name} retailer={row.retailer} />
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        {storeName(row.retailer)}
                        {row.source_category
                          ? ` · Store category: ${readableProductCategory(row.source_category, row.retailer)}`
                          : ""}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          row.outcome === "assigned" ||
                          row.manual_category !== null
                            ? "success"
                            : row.outcome === "waiting"
                              ? "secondary"
                              : "warning"
                        }
                      >
                        {categoryName(
                          row.manual_category ?? row.assigned_category,
                        )}
                      </Badge>
                      {row.manual_category !== null && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {row.classification?.source === "llm"
                            ? "LLM selected"
                            : row.classification?.source === "agent"
                              ? "Agent selected"
                              : "Human confirmed"}{" "}
                          · Original result:{" "}
                          {categoryName(row.assigned_category)}
                        </p>
                      )}
                      {row.outcome === "uncertain" &&
                        row.suggested_category &&
                        row.suggested_category !== "unknown" && (
                          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span>
                              Suggested: {categoryName(row.suggested_category)}
                            </span>
                            {row.member_id &&
                              row.manual_category === null &&
                              row.classification?.classification_id ===
                                row.classification_id &&
                              row.classification.suggested_category ===
                                row.suggested_category && (
                                <QuickCategoryApproval
                                  id={row.product_id}
                                  memberId={row.member_id}
                                  classification={row.classification}
                                  onUnauthorized={onUnauthorized}
                                  onSaved={() => {
                                    setReload((v) => v + 1);
                                    onCategoryChanged();
                                  }}
                                />
                              )}
                          </div>
                        )}
                    </TableCell>
                    <TableCell>
                      {row.probability === null
                        ? "—"
                        : percent(row.probability)}
                      {row.threshold !== null && (
                        <p className="text-xs text-muted-foreground">
                          Required: {percent(row.threshold)}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="max-w-64 whitespace-normal">
                      <p>
                        {row.manual_category !== null
                          ? row.classification?.source === "llm"
                            ? "LLM selected"
                            : row.classification?.source === "agent"
                              ? "Agent selected"
                              : "Human confirmed"
                          : row.outcome === "assigned"
                            ? "Assigned"
                            : row.outcome === "skipped"
                              ? "Skipped"
                              : row.outcome === "waiting"
                                ? "Waiting"
                                : row.outcome === "deferred"
                                  ? "Set aside for recovery"
                                  : "Needs review"}
                      </p>
                      {(row.outcome !== "assigned" || row.source === "llm") && (
                        <p className="text-xs text-muted-foreground">
                          {row.reason}
                        </p>
                      )}
                      {row.member_id && (
                        <ProductCategoryEditor
                          id={row.product_id}
                          memberId={row.member_id}
                          triggerLabel="Review category"
                          onUnauthorized={onUnauthorized}
                          onSaved={() => {
                            setReload((v) => v + 1);
                            onCategoryChanged();
                          }}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {data?.summary.total
                    ? "No products match these filters"
                    : "No products selected yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {data?.summary.total
                    ? "Try another name, category, or result filter."
                    : "The worker will add products here when this task starts."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-4">
          <p className="text-sm text-muted-foreground">
            {data?.total
              ? `${(data.page - 1) * data.size + 1}–${Math.min(data.page * data.size, data.total)} of ${number(data.total)} products`
              : "0 products"}
          </p>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || page <= 1}
              onClick={() => setPage((v) => v - 1)}
            >
              <ChevronLeft data-icon="inline-start" />
              Previous
            </Button>
            <span className="text-sm">
              Page {data?.page ?? page} of {Math.max(1, data?.total_pages ?? 1)}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || !data || data.page >= data.total_pages}
              onClick={() => setPage((v) => v + 1)}
            >
              Next
              <ChevronRight data-icon="inline-end" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function TaskResults(
  props: Parameters<typeof CategoryTaskResults>[0] & { kind?: string },
) {
  return props.kind === "match" ? (
    <MatchingTaskResults {...props} />
  ) : (
    <CategoryTaskResults {...props} />
  );
}
