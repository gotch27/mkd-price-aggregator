import { useEffect, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ArrowUpRight,
  RotateCcw,
  FolderOpen,
  SearchX,
} from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";
import { RecordCells } from "@/app/_components/dashboard/record-cells";
import type {
  DateFormatter,
  Row,
  TableView,
} from "@/app/_components/dashboard/types";
import { number } from "@/app/_components/dashboard/types";
const columns: Record<TableView, string[]> = {
  products: ["Store product", "Store", "Current price", "Matching", ""],
  universal: ["Universal product", "Stores", "Price range", "Matching", ""],
  sources: ["Catalog", "Products", "Status", "Last updated", ""],
  runs: ["Update", "Store", "Status", "Requested", "Attempts", ""],
  logs: ["Level", "Message", "Process", "Time", ""],
  decisions: [],
};
export function RecordsTable({
  view,
  rows,
  date,
  page,
  pageSize,
  busy,
  total,
  totalPages,
  onDetails,
  onRetry,
  onPageChange,
}: {
  view: TableView;
  rows: Row[];
  date: DateFormatter;
  page: number;
  pageSize: number;
  busy: boolean;
  total: number | null;
  totalPages: number | null;
  onDetails: (r: Row) => void;
  onRetry: (r: Row) => void;
  onPageChange: (p: number) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    viewport.current?.scrollTo({ top: 0 });
  }, [page, view]);
  const pages = totalPages ?? 0;
  const pageNumbers = Array.from(
    new Set(
      [1, page - 1, page, page + 1, pages].filter((n) => n > 0 && n <= pages),
    ),
  ).sort((a, b) => a - b);
  return (
    <section
      className="data-table"
      aria-label={`${view} results`}
      aria-busy={busy}
    >
      <div className="table-viewport" ref={viewport}>
        <Table>
          <TableHeader>
            <TableRow>
              {columns[view].map((c, i) => (
                <TableHead key={i}>
                  {c || <span className="sr-only">Actions</span>}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!rows.length && busy
              ? Array.from({ length: 10 }, (_, i) => (
                  <TableRow key={i}>
                    {columns[view].map((_, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-5 w-full min-w-12" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : rows.length
                ? rows.map((r, i) => (
                    <TableRow key={String(r.id ?? i)}>
                      <RecordCells view={view} row={r} date={date} />
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => onDetails(r)}
                          >
                            {view === "sources" ? "Open catalog" : "Details"}
                            {view === "sources" ? (
                              <FolderOpen data-icon="inline-end" />
                            ) : (
                              <ArrowUpRight data-icon="inline-end" />
                            )}
                          </Button>
                          {view === "runs" &&
                            ["failed", "quarantined"].includes(
                              String(r.status),
                            ) && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => onRetry(r)}
                              >
                                <RotateCcw data-icon="inline-start" />
                                Review retry
                              </Button>
                            )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                : null}
          </TableBody>
        </Table>
        {!rows.length && !busy && (
          <Empty className="min-h-64">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchX />
              </EmptyMedia>
              <EmptyTitle>
                No{" "}
                {view === "runs"
                  ? "updates"
                  : view === "logs"
                    ? "logs"
                    : view === "sources"
                      ? "catalogs"
                      : "products"}{" "}
                found
              </EmptyTitle>
              <EmptyDescription>
                Try another search or adjust your filters. New data appears
                after a successful store import.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
      <div className="pagination">
        <div className="pagination-info" aria-live="polite">
          {busy
            ? "Updating results…"
            : total
              ? `${number((page - 1) * pageSize + 1)}–${number(Math.min(page * pageSize, total))} of ${number(total)}`
              : total === 0
                ? "0 results"
                : "Loading results…"}
        </div>
        <Pagination className="m-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <Button
                aria-label="Previous page"
                variant="outline"
                size="sm"
                disabled={busy || page <= 1}
                onClick={() => onPageChange(page - 1)}
              >
                <ChevronLeft data-icon="inline-start" />
                <span className="hidden sm:inline">Previous</span>
              </Button>
            </PaginationItem>
            {pageNumbers.map((n, i) => (
              <PaginationItem key={n} className="hidden sm:flex">
                {i > 0 && n - pageNumbers[i - 1] > 1 && (
                  <span className="px-1 text-muted-foreground">…</span>
                )}
                <Button
                  aria-label={`Page ${n}`}
                  aria-current={page === n ? "page" : undefined}
                  size="icon-sm"
                  variant={page === n ? "secondary" : "ghost"}
                  disabled={busy}
                  onClick={() => onPageChange(n)}
                >
                  {n}
                </Button>
              </PaginationItem>
            ))}
            <PaginationItem>
              <Button
                aria-label="Next page"
                variant="outline"
                size="sm"
                disabled={busy || !pages || page >= pages}
                onClick={() => onPageChange(page + 1)}
              >
                <span className="hidden sm:inline">Next</span>
                <ChevronRight data-icon="inline-end" />
              </Button>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
        <span className="pagination-info">
          Page {pages ? number(page) : 0} of {number(pages)}
        </span>
      </div>
    </section>
  );
}
