import { useEffect, useState } from "react";
import {
  ExternalLink,
  Link2,
  Package,
  RotateCcw,
  ScrollText,
  ArrowRight,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
  CardAction,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableHeader,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Choice } from "@/app/_components/dashboard/filters";
import { StoreLogo } from "@/app/_components/dashboard/store-logo";
import { Status } from "@/app/_components/dashboard/status";
import { MatchingHistory } from "@/app/_components/dashboard/matching-history";
import {
  text,
  number,
  price,
  priceRange,
  storeName,
  kindName,
  label,
  type Row,
  type ProductDetail,
  type DateFormatter,
} from "@/app/_components/dashboard/types";
export type DetailSelection = { kind: "product" | "update" | "log"; row: Row };
function SourceLink({ url }: { url: unknown }) {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
  return (
    <Button asChild variant="link" size="sm">
      <a href={url} target="_blank" rel="noreferrer">
        View published source
        <ExternalLink data-icon="inline-end" />
      </a>
    </Button>
  );
}
function ReadableFields({ data }: { data: unknown }) {
  if (data === null || data === undefined)
    return (
      <p className="text-muted-foreground">
        No additional information recorded.
      </p>
    );
  if (typeof data !== "object")
    return (
      <span>
        {typeof data === "boolean" ? (data ? "Yes" : "No") : text(data)}
      </span>
    );
  if (Array.isArray(data))
    return (
      <div className="flex flex-col gap-3">
        {data.map((v, i) => (
          <ReadableFields key={i} data={v} />
        ))}
      </div>
    );
  const entries = Object.entries(data).filter(
    ([, v]) => v !== null && v !== undefined,
  );
  return entries.length ? (
    <dl className="detail-fields">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{label(k)}</dt>
          <dd>
            <ReadableFields data={v} />
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="text-muted-foreground">No additional information recorded.</p>
  );
}
function ProductAttributes({ value }: { value: unknown }) {
  const a = (value ?? {}) as Row;
  return (
    <dl className="detail-fields">
      {[
        ["Brand", a.brand],
        ["Size", a.quantity ? `${a.quantity} ${text(a.unit, "")}` : null],
        ["Pack size", a.pack],
        ["Variant", a.variant],
        ["Barcode", a.gtin],
      ].map(([key, v]) => (
        <div key={String(key)}>
          <dt>{text(key)}</dt>
          <dd>{text(v, "Not provided")}</dd>
        </div>
      ))}
    </dl>
  );
}
function ProductContent({
  id,
  date,
  pageSize,
  onUnauthorized,
}: {
  id: string;
  date: DateFormatter;
  pageSize: number;
  onUnauthorized: () => void;
}) {
  const [state, setState] = useState<{
    id: string;
    data: ProductDetail | null;
    error: string;
  }>({ id: "", data: null, error: "" });
  const [revision, setRevision] = useState(0);
  const [store, setStore] = useState("");
  const [catalog, setCatalog] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    const controller = new AbortController();
    setState({ id, data: null, error: "" });
    setStore("");
    setCatalog("");
    setPage(1);
    void (async () => {
      try {
        const response = await fetch(`/api/products/${id}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.status === 401) {
          onUnauthorized();
          return;
        }
        const r = await response.json();
        if (!r.ok)
          throw new Error(
            r.errors?.[0]?.message ?? "Unable to load product details",
          );
        if (!controller.signal.aborted)
          setState({ id, data: r.data, error: "" });
      } catch (e) {
        if (!controller.signal.aborted)
          setState({
            id,
            data: null,
            error: e instanceof Error ? e.message : String(e),
          });
      }
    })();
    return () => controller.abort();
  }, [id, revision, onUnauthorized]);
  if (state.id === id && state.error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Unable to load product</AlertTitle>
        <AlertDescription>
          {state.error}
          <Button variant="outline" onClick={() => setRevision((v) => v + 1)}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (state.id !== id || !state.data)
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-10" />
        <Skeleton className="h-60" />
      </div>
    );
  const { product, listings, offers, decisions } = state.data;
  const stores = [...new Set(offers.map((o) => text(o.retailer)))];
  const filtered = offers.filter(
    (o) =>
      (!store || o.retailer === store) &&
      text(o.branch).toLowerCase().includes(catalog.toLowerCase()),
  );
  const pages = Math.ceil(filtered.length / pageSize);
  const currentPage = Math.min(page, Math.max(1, pages));
  return (
    <div className="flex flex-col gap-6">
      <div className="product-identity">
        <span className="product-symbol">
          <Package />
        </span>
        <div>
          <h3>{text(product.name)}</h3>
          <p className="text-sm text-muted-foreground">
            {number(listings.length)} store products · {number(stores.length)}{" "}
            stores
          </p>
          <Status value={stores.length > 1 ? "matched" : "separate"} />
        </div>
      </div>
      <Tabs defaultValue="listings">
        <TabsList>
          <TabsTrigger value="listings">Store products</TabsTrigger>
          <TabsTrigger value="prices">Catalog prices</TabsTrigger>
          <TabsTrigger value="matching">Matching</TabsTrigger>
        </TabsList>
        <TabsContent value="listings" className="pt-4">
          <div className="flex flex-col gap-4">
            {listings.map((l) => (
              <Card key={text(l.id)}>
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <StoreLogo slug={text(l.retailer)} />
                    <div>
                      <CardTitle>{storeName(l.retailer)}</CardTitle>
                      <CardDescription>{text(l.name)}</CardDescription>
                    </div>
                  </div>
                  <CardAction>
                    <Badge variant="outline">
                      {number(l.catalog_count)} catalogs
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <div className="price-value mb-4">{priceRange(l)}</div>
                  <ProductAttributes value={l.attributes} />
                  {Boolean(l.description) && (
                    <p className="mt-4 text-sm text-muted-foreground">
                      {text(l.description)}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
            {!listings.length && (
              <Alert>
                <AlertTitle>No current store products</AlertTitle>
                <AlertDescription>
                  This identity has no products in the current browser index.
                  Catalog prices may contain more recent observations.
                </AlertDescription>
              </Alert>
            )}
          </div>
        </TabsContent>
        <TabsContent value="prices" className="pt-4">
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Prices as published by each store. Shared online catalogs are
              labeled separately from branch prices.
            </p>
            <div className="flex flex-wrap gap-2">
              <Choice
                label="Price store"
                value={store}
                options={[
                  ["", "All stores"],
                  ...stores.map((s) => [s, storeName(s)] as [string, string]),
                ]}
                onChange={(v) => {
                  setStore(v);
                  setPage(1);
                }}
              />
              <Input
                aria-label="Search catalog prices"
                placeholder="Find a branch or catalog…"
                className="min-w-44 flex-1"
                value={catalog}
                onChange={(e) => {
                  setCatalog(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Store / catalog</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Observed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered
                  .slice((currentPage - 1) * pageSize, currentPage * pageSize)
                  .map((o, i) => (
                    <TableRow key={`${o.listing_id}-${o.source_id}-${i}`}>
                      <TableCell>
                        <div className="cell-title">
                          {storeName(o.retailer)}
                        </div>
                        <div className="cell-note">{text(o.branch)}</div>
                        <Badge variant="outline">
                          {o.scope === "branch"
                            ? "Branch price"
                            : "Shared online catalog"}
                        </Badge>
                        <div className="cell-note">
                          {o.available === true
                            ? "Available"
                            : o.available === false
                              ? "Unavailable"
                              : "Availability unknown"}
                        </div>
                        <SourceLink url={o.source_url} />
                      </TableCell>
                      <TableCell>
                        <div className="price-value">{price(o.price)}</div>
                        {o.regular_price !== null &&
                          o.regular_price !== undefined && (
                            <div className="cell-note">
                              Regular: {price(o.regular_price)}
                            </div>
                          )}
                        {Boolean(o.promotion) && (
                          <div className="cell-note">{text(o.promotion)}</div>
                        )}
                        {Boolean(o.unit_price) && (
                          <div className="cell-note">{text(o.unit_price)}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="cell-date">
                          {date(o.retrieved_at)}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                {!filtered.length && (
                  <TableRow>
                    <TableCell colSpan={3}>
                      No catalog prices match these filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {number(filtered.length)} observations · Page{" "}
                {pages ? currentPage : 0} of {pages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= pages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="matching" className="pt-4">
          <div className="flex flex-col gap-4">
            <Alert>
              <Link2 />
              <AlertTitle>Why these products match</AlertTitle>
              <AlertDescription>
                Matching connects equivalent store products to one universal
                product. Size, pack count, and variant differences can keep
                products separate.
              </AlertDescription>
            </Alert>
            <ProductAttributes value={product.attributes} />
            <MatchingHistory decisions={decisions} date={date} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
export function DetailSheet({
  selection,
  date,
  pageSize,
  onClose,
  onRetry,
  onLogs,
  onUnauthorized,
}: {
  selection: DetailSelection | null;
  date: DateFormatter;
  pageSize: number;
  onClose: () => void;
  onRetry: (r: Row) => void;
  onLogs: (id: string) => void;
  onUnauthorized: () => void;
}) {
  const [lastSelection, setLastSelection] = useState(selection);
  useEffect(() => {
    if (selection) setLastSelection(selection);
  }, [selection]);
  const displayed = selection ?? lastSelection;
  const row = displayed?.row;
  return (
    <Sheet
      open={selection !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="detail-sheet">
        <SheetHeader>
          <SheetTitle>
            {displayed?.kind === "product"
              ? "Product details"
              : displayed?.kind === "update"
                ? "Update details"
                : "Log details"}
          </SheetTitle>
          <SheetDescription>
            {displayed?.kind === "product"
              ? "Store listings, catalog prices, and the reasons behind product matches."
              : displayed?.kind === "update"
                ? "Progress, timing, and results for this data update."
                : "Event context and technical information."}
          </SheetDescription>
        </SheetHeader>
        <div className="detail-body">
          {displayed?.kind === "product" && (
            <ProductContent
              key={text(row?.product_id)}
              id={text(row?.product_id)}
              date={date}
              pageSize={pageSize}
              onUnauthorized={onUnauthorized}
            />
          )}
          {row && displayed?.kind === "update" && (
            <div className="flex flex-col gap-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold">
                    {kindName(row.kind)}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {row.retailer ? storeName(row.retailer) : "All stores"} ·{" "}
                    {text(row.source_name, "All applicable catalogs")}
                  </p>
                </div>
                <Status value={row.status} />
              </div>
              <dl className="detail-fields">
                <div>
                  <dt>Requested</dt>
                  <dd>{date(row.created_at)}</dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd>{date(row.started_at)}</dd>
                </div>
                <div>
                  <dt>Finished</dt>
                  <dd>{date(row.finished_at)}</dd>
                </div>
                <div>
                  <dt>Attempts</dt>
                  <dd>{number(row.attempts)}</dd>
                </div>
              </dl>
              {Boolean(row.error) && (
                <Alert variant="destructive">
                  <AlertTitle>Update needs attention</AlertTitle>
                  <AlertDescription>{text(row.error)}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-wrap gap-2">
                {["failed", "quarantined"].includes(text(row.status)) && (
                  <Button variant="outline" onClick={() => onRetry(row)}>
                    <RotateCcw data-icon="inline-start" />
                    Review retry
                  </Button>
                )}
                <Button variant="outline" onClick={() => onLogs(text(row.id))}>
                  <ScrollText data-icon="inline-start" />
                  View related logs
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </div>
              <Card>
                <CardHeader>
                  <CardTitle>Results</CardTitle>
                  <CardDescription>What this update completed</CardDescription>
                </CardHeader>
                <CardContent>
                  <ReadableFields data={row.summary} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Progress</CardTitle>
                  <CardDescription>Last saved checkpoint</CardDescription>
                </CardHeader>
                <CardContent>
                  <ReadableFields data={row.checkpoint} />
                </CardContent>
              </Card>
              <Accordion type="single" collapsible>
                <AccordionItem value="reference">
                  <AccordionTrigger>Reference</AccordionTrigger>
                  <AccordionContent>
                    <dl className="detail-fields">
                      <div>
                        <dt>Update ID</dt>
                        <dd>{text(row.id)}</dd>
                      </div>
                      <div>
                        <dt>Parent update</dt>
                        <dd>{text(row.parent_id)}</dd>
                      </div>
                    </dl>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          )}
          {row && displayed?.kind === "log" && (
            <div className="flex flex-col gap-5">
              <Status value={row.level} />
              <h3 className="text-lg font-medium">{text(row.message)}</h3>
              <dl className="detail-fields">
                <div>
                  <dt>Time</dt>
                  <dd>{date(row.created_at)}</dd>
                </div>
                <div>
                  <dt>Process</dt>
                  <dd>{text(row.process)}</dd>
                </div>
                <div>
                  <dt>Store</dt>
                  <dd>{row.retailer ? storeName(row.retailer) : "—"}</dd>
                </div>
                <div>
                  <dt>Update ID</dt>
                  <dd>{text(row.run_id)}</dd>
                </div>
                <div>
                  <dt>Correlation ID</dt>
                  <dd>{text(row.correlation_id)}</dd>
                </div>
              </dl>
              <Accordion type="multiple" defaultValue={["payload"]}>
                <AccordionItem value="payload">
                  <AccordionTrigger>Log data (JSON)</AccordionTrigger>
                  <AccordionContent>
                    <pre className="log-json">
                      {JSON.stringify(row.data, null, 2) ?? "No log data"}
                    </pre>
                  </AccordionContent>
                </AccordionItem>
                {Boolean(row.error) && (
                  <AccordionItem value="error">
                    <AccordionTrigger>Error details (JSON)</AccordionTrigger>
                    <AccordionContent>
                      <pre className="log-json">
                        {JSON.stringify(row.error, null, 2)}
                      </pre>
                    </AccordionContent>
                  </AccordionItem>
                )}
              </Accordion>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
