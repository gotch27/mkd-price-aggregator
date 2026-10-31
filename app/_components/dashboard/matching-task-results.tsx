"use client";
import { useEffect, useState, useRef } from "react";
import { ListChecks, RefreshCw } from "lucide-react";
import type { MatchingResultsPage } from "@/nextsignal/domain/matching-results";
import { matchingOutcomes } from "@/nextsignal/domain/matching-results";
import { factLabels } from "@/nextsignal/domain/product-facts";
import type { FactName } from "@/nextsignal/domain/matching";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { taskApi } from "./task-api";
import { storeName } from "./types";
const label = (v: string) =>
  v.replaceAll("_", " ").replace(/^./, (s) => s.toUpperCase());
export function MatchingTaskResults({
  id,
  updatedAt,
  pageSize,
  onUnauthorized,
  onProduct,
}: {
  id: string;
  updatedAt: string;
  pageSize: number;
  onUnauthorized: () => void;
  onProduct: (id: string) => void;
}) {
  const openingProduct = useRef(false);
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [outcome, setOutcome] = useState("all"),
    [refresh, setRefresh] = useState(0),
    [data, setData] = useState<MatchingResultsPage | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    const query = new URLSearchParams({
      page: String(page),
      size: String(pageSize),
      search,
      category: "",
      outcome: outcome === "all" ? "" : outcome,
    });
    void taskApi<MatchingResultsPage>(
      `/api/tasks/${id}/results?${query}`,
      onUnauthorized,
      { signal: abort.signal },
    )
      .then((result) => {
        if (!abort.signal.aborted) {
          setData(result);
          setPage(result.page);
          setError("");
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [
    open,
    id,
    updatedAt,
    page,
    pageSize,
    search,
    outcome,
    refresh,
    onUnauthorized,
  ]);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
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
          <SheetTitle>Matching results</SheetTitle>
          <SheetDescription>
            Saved connections, candidate comparisons, and the information still
            needed. Viewing results makes no AI calls.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Could not load matching results</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {data && (
            <>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.summary)
                  .filter(([, n]) => n > 0)
                  .map(([key, n]) => (
                    <Badge
                      key={key}
                      variant={key === "connected" ? "default" : "secondary"}
                    >
                      {n} {label(key)}
                    </Badge>
                  ))}
              </div>
              <p>
                Phase: {label(data.task.phase)} · {data.task.processed} products
                checked · ${Number(data.task.spending_usd).toFixed(4)} ·{" "}
                {data.task.requests} requests
              </p>
              <p className="text-sm text-muted-foreground">
                Extra counterpart interpretations:{" "}
                {data.task.counterparts_consumed} used /{" "}
                {data.task.counterparts_planned} planned
              </p>
            </>
          )}
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`matching-search-${id}`}>
                Find a product
              </FieldLabel>
              <Input
                id={`matching-search-${id}`}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`matching-outcome-${id}`}>Result</FieldLabel>
              <Select
                value={outcome}
                onValueChange={(v) => {
                  setOutcome(v);
                  setPage(1);
                }}
              >
                <SelectTrigger id={`matching-outcome-${id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All results</SelectItem>
                    {matchingOutcomes.map((v) => (
                      <SelectItem key={v} value={v}>
                        {label(v)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <Accordion type="multiple">
            {data?.rows.map((row) => (
              <AccordionItem key={row.id} value={row.id}>
                <AccordionTrigger>
                  <span className="flex flex-col gap-1 text-left">
                    <span>
                      {row.name} · {storeName(row.retailer)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {label(row.outcome)} · {row.reason}
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-3">
                    <p>Stores: {row.stores.map(storeName).join(", ")}</p>
                    {row.product_id && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          openingProduct.current = true;
                          setOpen(false);
                          onProduct(row.product_id);
                        }}
                      >
                        Open product details
                      </Button>
                    )}
                    {row.candidates.map((candidate) => (
                      <div
                        key={candidate.id}
                        className="flex flex-col gap-2 rounded-md border p-3"
                      >
                        <p>
                          {candidate.name} · {storeName(candidate.retailer)}
                        </p>
                        <p>
                          {label(candidate.outcome)} · {candidate.reason}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {candidate.method === "decision"
                            ? `Same-product probability: ${candidate.probability === null ? "unavailable" : (candidate.probability * 100).toFixed(2) + "%"}`
                            : "Code-based check"}
                          {candidate.confidence !== null
                            ? ` · Gateway confidence: ${(candidate.confidence * 100).toFixed(2)}%`
                            : ""}
                        </p>
                        {Object.entries(candidate.facts).map(
                          ([field, fact]) => (
                            <p key={field} className="text-sm">
                              {factLabels[field as FactName] ?? label(field)}:{" "}
                              {candidate.source_facts[field as FactName]
                                ?.value ?? "Unknown"}{" "}
                              ↔ {fact.value}
                              <span className="block text-muted-foreground">
                                Store evidence: “{fact.quote}”
                              </span>
                            </p>
                          ),
                        )}
                        <p className="text-sm text-muted-foreground">
                          Found through: {candidate.retrieval.join(", ")}
                        </p>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
          {data?.rows.length === 0 && <p>No products have this result.</p>}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRefresh((v) => v + 1)}
            >
              <RefreshCw data-icon="inline-start" />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((v) => v - 1)}
            >
              Previous
            </Button>
            <span>
              Page {page} of {Math.max(1, data?.total_pages ?? 1)}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!data || page >= data.total_pages}
              onClick={() => setPage((v) => v + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
