"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Bot, Tags, Square, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type {
  BrandReviewContext,
  BrandReviewDecision,
  BrandReviewSession,
} from "@/nextsignal/domain/brand-review";
import { registerPageTools } from "@/lib/webmcp";
import { brandReviewTools } from "@/lib/brand-review-tools";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardAction,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import {
  Table,
  TableBody,
  TableRow,
  TableCell,
  TableHeader,
  TableHead,
} from "@/components/ui/table";
import { BrandReviewChoice } from "./brand-review-choice";
import { taskApi } from "./task-api";
import { label, storeName, number, storeNames } from "./types";

const base = "/api/review/brand-sessions";
export function BrandReview({
  onUnauthorized,
  onChanged,
  onAgentActivity,
}: {
  onUnauthorized: () => void;
  onChanged: () => void;
  onAgentActivity: () => void;
}) {
  const id = useId();
  const [context, setContext] = useState<BrandReviewContext | null>(null),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [retailer, setRetailer] = useState("all"),
    [search, setSearch] = useState(""),
    [limit, setLimit] = useState<string | null>(null),
    [retry, setRetry] = useState<boolean | null>(null),
    [page, setPage] = useState(1);
  const current = useRef({
    onUnauthorized,
    onChanged,
    onAgentActivity,
    retailer,
    search,
  });
  current.current = {
    onUnauthorized,
    onChanged,
    onAgentActivity,
    retailer,
    search,
  };
  const requests = useRef(new Map<string, string>());
  const requestId = (key: string) => {
    const prior = requests.current.get(key);
    if (prior) return prior;
    const value = crypto.randomUUID();
    requests.current.set(key, value);
    return value;
  };
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await taskApi<BrandReviewContext>(
      base,
      () => current.current.onUnauthorized(),
      { signal },
    );
    if (!signal?.aborted) {
      setContext(result);
      setError("");
    }
    return result;
  }, []);
  useEffect(() => {
    const lifecycle = new AbortController();
    void refresh(lifecycle.signal)
      .then(async (config) => {
        const tools = brandReviewTools(
          config,
          Object.keys(storeNames),
          () => ({
            retailer: current.current.retailer,
            search: current.current.search,
          }),
          async (path, input, signal) => {
            const result = await taskApi<unknown>(
              path,
              () => current.current.onUnauthorized(),
              input
                ? {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(input),
                    signal,
                  }
                : { signal },
            );
            if (input) {
              await refresh(lifecycle.signal);
              current.current.onAgentActivity();
              if (path.endsWith("/decisions") || path.endsWith("/undo"))
                current.current.onChanged();
            }
            return result;
          },
        );
        const available = await registerPageTools(
          tools,
          document as unknown as Parameters<typeof registerPageTools>[1],
          navigator as unknown as Parameters<typeof registerPageTools>[2],
          lifecycle.signal,
        );
        if (!lifecycle.signal.aborted) setReady(available);
      })
      .catch((e) => {
        if (!lifecycle.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Could not load brand review",
          );
      });
    return () => lifecycle.abort();
  }, [refresh]);
  useEffect(() => {
    if (
      !context ||
      (context.session?.state !== "active" && !context.refresh_pending)
    )
      return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void refresh(controller.signal).catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not refresh review");
      });
    }, context.limits.refresh_ms);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [
    context?.session?.state,
    context?.refresh_pending,
    context?.limits.refresh_ms,
    refresh,
  ]);
  useEffect(() => setPage(1), [context?.session?.id]);
  async function mutate(
    path: string,
    input: Record<string, unknown>,
    message: string,
  ) {
    setBusy(true);
    try {
      const result = await taskApi<BrandReviewSession>(path, onUnauthorized, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      await refresh();
      onChanged();
      if (message) toast.success(message);
      return result;
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Could not save brand review",
      );
      await refresh().catch(() => {});
      return null;
    } finally {
      setBusy(false);
    }
  }
  const session = context?.session?.acknowledged_at ? null : context?.session;
  const item =
    session?.options.reviewer === "human" && session.state === "active"
      ? session.results.find((r) => r.state === "pending")
      : null;
  const size = context?.limits.results_page_size;
  const rows =
    session && size
      ? session.results.slice((page - 1) * size, page * size)
      : [];
  async function start() {
    if (!context) return;
    const input = {
      limit: Number(limit ?? context.limits.default_groups),
      retailer: retailer === "all" ? undefined : retailer,
      search,
      include_previously_skipped:
        retry ?? context.limits.default_include_previously_skipped,
      reviewer: "human",
      agent_name: "",
      agent_model: "",
    };
    const key = JSON.stringify(input);
    const result = await mutate(
      base,
      { ...input, request_id: requestId(key) },
      "Brand review ready",
    );
    if (result) requests.current.delete(key);
  }
  async function submit(decision: BrandReviewDecision) {
    if (!session) return;
    const result = await mutate(
      `${base}/${session.id}/decisions`,
      {
        reviewer: "human",
        request_id: requestId(JSON.stringify([session.id, decision])),
        decisions: [decision],
      },
      "",
    );
    const row = result?.results.find((r) => r.id === decision.item_id);
    if (row?.state === "rejected") toast.error(row.reason);
    else if (row)
      toast.success(
        decision.action === "save"
          ? "Brand spelling saved"
          : "Skipped; unchanged products will not repeat",
      );
  }
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Tags /> Brand review
          </CardTitle>
          <CardDescription>
            Connect source spellings to canonical brands. Work uses available
            unique store products, with no paid model calls.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field>
              <FieldLabel htmlFor={`${id}-store`}>Store</FieldLabel>
              <Select value={retailer} onValueChange={setRetailer}>
                <SelectTrigger id={`${id}-store`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All stores</SelectItem>
                    {Object.entries(storeNames).map(([key, name]) => (
                      <SelectItem key={key} value={key}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-search`}>Product name</FieldLabel>
              <Input
                id={`${id}-search`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Optional filter"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-limit`}>Spelling groups</FieldLabel>
              <Input
                id={`${id}-limit`}
                type="number"
                min={1}
                max={context?.limits.max_groups}
                value={limit ?? context?.limits.default_groups ?? ""}
                onChange={(e) => setLimit(e.target.value)}
              />
            </Field>
            <Field className="justify-end">
              <Button
                disabled={
                  busy ||
                  !context ||
                  context.session?.state === "active" ||
                  Number(limit ?? context?.limits.default_groups) < 1
                }
                onClick={() => void start()}
              >
                Start human review
              </Button>
            </Field>
            <Field orientation="horizontal" className="sm:col-span-2">
              <Checkbox
                id={`${id}-retry`}
                checked={
                  retry ??
                  context?.limits.default_include_previously_skipped ??
                  false
                }
                onCheckedChange={(v) => setRetry(v === true)}
              />
              <FieldLabel htmlFor={`${id}-retry`}>
                Include previously skipped products
              </FieldLabel>
            </Field>
          </FieldGroup>
          <p className="mt-3 text-xs text-muted-foreground">
            Impact counts come from a bounded sample of up to{" "}
            {context ? number(context.limits.scan_products) : "…"} products.
            They are not full-catalog totals.
          </p>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot />{" "}
            {session?.options.reviewer === "human"
              ? "Brand review progress"
              : "Agent brand review"}{" "}
            {session && (
              <Badge variant="secondary">
                {label(session.state)} · {label(session.options.reviewer)}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {ready
              ? `Ask your agent to review brands with WebMCP. Default: ${context?.limits.default_groups} spelling groups; ${context?.limits.batch_size} per batch.`
              : "Human review is available. Agent tools require a WebMCP-capable browser."}
          </CardDescription>
          {session && (
            <CardAction className="flex flex-wrap gap-2">
              {session.can_undo && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      `${base}/${session.id}/undo`,
                      { reviewer: "human" },
                      "Batch undone where no newer edit intervened",
                    )
                  }
                >
                  <Undo2 />
                  Undo last batch
                </Button>
              )}
              {session.state === "active" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      `${base}/${session.id}/stop`,
                      {},
                      "Review stopped",
                    )
                  }
                >
                  <Square />
                  Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      `${base}/${session.id}/acknowledge`,
                      {},
                      "Results hidden. Brands and history are kept.",
                    )
                  }
                >
                  OK
                </Button>
              )}
            </CardAction>
          )}
        </CardHeader>
        {(session || !!context?.refresh_pending) && (
          <CardContent className="flex flex-col gap-3">
            {session && (
              <>
                <p aria-live="polite">
                  {number(session.processed)} / {number(session.total)} reviewed
                  · {number(session.saved)} saved · {number(session.skipped)}{" "}
                  skipped · {number(session.rejected)} changed or rejected
                </p>
                <Accordion type="single" collapsible>
                  <AccordionItem value="results">
                    <AccordionTrigger>Review results</AccordionTrigger>
                    <AccordionContent>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Source spelling</TableHead>
                            <TableHead>Brand</TableHead>
                            <TableHead>Result</TableHead>
                            <TableHead>Reason</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.map((row) => (
                            <TableRow key={row.id}>
                              <TableCell>
                                {row.term}
                                <p className="text-xs text-muted-foreground">
                                  {[
                                    ...new Set(
                                      row.examples.map((e) =>
                                        storeName(e.retailer),
                                      ),
                                    ),
                                  ].join(", ")}
                                </p>
                              </TableCell>
                              <TableCell>{row.brand_name ?? "—"}</TableCell>
                              <TableCell>
                                {row.undo_status === "restored"
                                  ? "Undone"
                                  : row.undo_status === "changed"
                                    ? "Newer edit preserved"
                                    : label(row.state)}
                              </TableCell>
                              <TableCell className="max-w-96 whitespace-normal">
                                {row.reason}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      {size && session.total > size && (
                        <div className="mt-3 flex items-center justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={page === 1}
                            onClick={() => setPage((p) => p - 1)}
                          >
                            Previous
                          </Button>
                          <span>
                            {page} / {Math.ceil(session.total / size)}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={page * size >= session.total}
                            onClick={() => setPage((p) => p + 1)}
                          >
                            Next
                          </Button>
                        </div>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </>
            )}
            {!!context?.refresh_pending && (
              <p className="text-xs text-muted-foreground">
                {number(context.refresh_pending)} local brand refresh jobs
                waiting or running. Saved categories and connections are kept.
              </p>
            )}
          </CardContent>
        )}
      </Card>
      {item && context && (
        <BrandReviewChoice
          key={item.id}
          item={item}
          size={context.limits.results_page_size}
          busy={busy}
          onUnauthorized={onUnauthorized}
          onSubmit={submit}
        />
      )}
    </div>
  );
}
