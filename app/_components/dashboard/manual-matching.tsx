import { useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Link2, Search, Unlink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
  CardContent,
} from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";
import { Choice } from "@/app/_components/dashboard/filters";
import { StoreLogo } from "@/app/_components/dashboard/store-logo";
import { ProductName } from "./product-name";
import { readableProductText } from "@/nextsignal/domain/product-text";
import { storeName, storeNames } from "@/app/_components/dashboard/types";
import type {
  ManualGroup,
  ManualMember,
  ManualSearch,
  ManualCommand,
} from "@/nextsignal/domain/manual-matching";

const factLabels: Record<string, string> = {
  brand: "Brand",
  type: "Type",
  variant: "Variant",
  quantity: "Amount",
  unit: "Unit",
  pack: "Pack",
  form: "Container",
  size: "Size",
  model: "Model",
  fat: "Fat %",
  alcohol: "Alcohol %",
  range: "Range",
  flavour: "Flavour",
  shade: "Shade",
  variety: "Variety",
  sale_unit: "Sold by",
  origin: "Origin",
  grade: "Grade",
  processing: "Processing",
  gtin: "Barcode",
};
function Member({
  member,
  action,
}: {
  member: ManualMember;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <StoreLogo slug={member.retailer} />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-sm font-medium">
            <ProductName
              name={member.name}
              retailer={member.retailer}
              showSource
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {storeName(member.retailer)}
            {!member.active ? " · Currently unavailable" : ""}
          </p>
          {member.description && (
            <p className="text-xs text-muted-foreground">
              {readableProductText(member.description, member.retailer)}
            </p>
          )}
          <dl className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {Object.entries(member.facts).map(([key, fact]) => (
              <div key={key} title={fact.quote}>
                <dt className="inline">{factLabels[key] ?? key}: </dt>
                <dd className="inline">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      {action}
    </div>
  );
}
export function ManualMatching({
  id,
  onSaved,
  onUnauthorized,
}: {
  id: string;
  onSaved: () => void;
  onUnauthorized: () => void;
}) {
  const fieldId = useId();
  const [data, setData] = useState<ManualSearch | null>(null);
  const [search, setSearch] = useState("");
  const [store, setStore] = useState("");
  const [applied, setApplied] = useState({ search: "", store: "" });
  const request = useRef<AbortController | null>(null);
  const results = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<{
    candidate?: ManualGroup;
    member?: ManualMember;
  } | null>(null);
  const [lastReview, setLastReview] = useState<typeof review>(null);
  useEffect(() => {
    if (review) setLastReview(review);
  }, [review]);
  const displayedReview = review ?? lastReview;
  const [note, setNote] = useState("");
  const [searched, setSearched] = useState(false);
  async function load(term: string, retailer: string, page: number) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams({ search: term, page: String(page) });
      if (retailer) query.set("retailer", retailer);
      const response = await fetch(`/api/products/${id}/matching?${query}`, {
        signal,
        cache: "no-store",
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      const result = await response.json();
      if (!result.ok)
        throw new Error(
          result.errors?.[0]?.message ?? "Unable to load matching products",
        );
      if (!signal.aborted) {
        setData(result.data);
        setApplied({ search: term, store: retailer });
        if (results.current) results.current.scrollTop = 0;
      }
    } catch (e) {
      if (!signal.aborted)
        setError(e instanceof Error ? e.message : "Unable to load products");
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void load("", "", 1);
    return () => request.current?.abort();
  }, [id]);
  async function save() {
    if (!data?.group || !review) return;
    const command: ManualCommand = {
      id,
      snapshot: data.group.snapshot,
      note,
      action: review.candidate ? "connect" : "separate",
      ...(review.candidate
        ? {
            candidate_id: review.candidate.id,
            candidate_snapshot: review.candidate.snapshot,
          }
        : { member_id: review.member!.id }),
    };
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/products/${id}/matching`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      const result = await response.json();
      if (!result.ok)
        throw new Error(
          result.errors?.[0]?.message ?? "Unable to save connection",
        );
      toast.success("Decision saved", {
        description: review.candidate
          ? "Connection saved. It will be reused when these products return in later imports."
          : "Products separated. The saved decision will prevent them being joined again automatically.",
      });
      setReview(null);
      setNote("");
      setSearched(false);
      await load("", "", 1);
      onSaved();
    } catch (e) {
      toast.error("Unable to update matches", {
        description:
          e instanceof Error ? e.message : "Unable to save connection",
      });
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      {error && !review && (
        <Alert variant="destructive">
          <AlertTitle>Unable to update matches</AlertTitle>
          <AlertDescription>
            {error}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setReview(null);
                void load(applied.search, applied.store, data?.page ?? 1);
              }}
            >
              Reload products
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Matches across stores</CardTitle>
          <CardDescription>
            Connect the same exact product from another store. Saved connections
            are reused in future imports.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!data && busy ? (
            <Skeleton className="h-24" />
          ) : data?.group?.members.length ? (
            <div className="divide-y">
              {data.group.members.map((member) => (
                <Member
                  key={member.id}
                  member={member}
                  action={
                    data.group!.members.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={saving || data.group!.limited}
                        onClick={() => {
                          setError("");
                          setNote("");
                          setReview({ member });
                        }}
                      >
                        <Unlink data-icon="inline-start" />
                        Separate
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No store products are available for this group.
            </p>
          )}
          {data?.group?.limited && (
            <Alert variant="destructive">
              <AlertTitle>Group needs attention</AlertTitle>
              <AlertDescription>
                This product group exceeds the manual editing limit. Its
                connections have not been changed.
              </AlertDescription>
            </Alert>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || saving) return;
              setReview(null);
              setSearched(true);
              void load(search, store, 1);
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${fieldId}-search`}>
                  Find a product in another store
                </FieldLabel>
                <div className="flex flex-wrap gap-2">
                  <Input
                    id={`${fieldId}-search`}
                    className="min-w-40 flex-1"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setSearched(false);
                    }}
                    placeholder="Product name, brand or model…"
                    minLength={data?.limits.search_min_length}
                    required
                    disabled={saving || busy}
                  />
                  <Choice
                    label="Search store"
                    value={store}
                    onChange={(value) => {
                      setStore(value);
                      setSearched(false);
                    }}
                    options={[
                      ["", "All stores"],
                      ...Object.entries(storeNames),
                    ]}
                  />
                  <Button
                    variant="outline"
                    type="submit"
                    disabled={
                      busy ||
                      saving ||
                      !data?.group ||
                      data.group.limited ||
                      (data &&
                        search.trim().length < data.limits.search_min_length)
                    }
                  >
                    <Search data-icon="inline-start" />
                    {busy ? "Searching…" : "Search"}
                  </Button>
                </div>
                <FieldDescription>
                  Search results are not confirmed matches. Check size, flavour,
                  pack and model before connecting. Add more words or choose a
                  store to narrow the results.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
          {searched && !busy && data?.candidates.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No products found</EmptyTitle>
                <EmptyDescription>
                  Try fewer words, a different spelling, or another store.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {searched && data && (data.total > 0 || busy) && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground" role="status">
                {busy
                  ? "Updating results…"
                  : `${(data.page - 1) * data.page_size + 1}–${Math.min(data.page * data.page_size, data.total)} of ${data.total} search results`}
              </p>
              <Pagination
                aria-label="Matching search pages"
                className="m-0 w-auto"
              >
                <PaginationContent>
                  <PaginationItem>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label="Previous matching results"
                      disabled={busy || saving || data.page <= 1}
                      onClick={() =>
                        void load(applied.search, applied.store, data.page - 1)
                      }
                    >
                      <ChevronLeft data-icon="inline-start" />
                      Previous
                    </Button>
                  </PaginationItem>
                  <PaginationItem>
                    <span className="px-2 text-xs text-muted-foreground">
                      Page {data.total_pages ? data.page : 0} of{" "}
                      {data.total_pages}
                    </span>
                  </PaginationItem>
                  <PaginationItem>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label="Next matching results"
                      disabled={busy || saving || data.page >= data.total_pages}
                      onClick={() =>
                        void load(applied.search, applied.store, data.page + 1)
                      }
                    >
                      Next
                      <ChevronRight data-icon="inline-end" />
                    </Button>
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          )}
          {searched &&
          busy &&
          (applied.search !== search || applied.store !== store) ? (
            <Skeleton className="h-96" />
          ) : (
            searched &&
            !!data?.candidates.length && (
              <div
                ref={results}
                className="flex h-[min(50dvh,28rem)] flex-col gap-3 overflow-y-auto overscroll-contain"
                role="region"
                aria-label="Matching search results"
                aria-busy={busy}
              >
                {data.candidates.map((candidate) => (
                  <Card key={candidate.id} size="sm" className="shrink-0">
                    {candidate.members.length > 1 && (
                      <CardHeader>
                        <CardTitle>
                          Connected across {candidate.members.length} stores
                        </CardTitle>
                        <CardDescription>
                          Review every product before connecting this group.
                        </CardDescription>
                      </CardHeader>
                    )}
                    <CardContent>
                      <div className="divide-y">
                        {candidate.members.map((m) => (
                          <Member key={m.id} member={m} />
                        ))}
                      </div>
                    </CardContent>
                    <CardFooter className="justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || saving || candidate.limited}
                        onClick={() => {
                          setError("");
                          setNote("");
                          setReview({ candidate });
                        }}
                      >
                        <Link2 data-icon="inline-start" />
                        Review connection
                      </Button>
                    </CardFooter>
                  </Card>
                ))}
              </div>
            )
          )}
        </CardContent>
      </Card>
      <AlertDialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setReview(null);
            setError("");
          }
        }}
      >
        <AlertDialogContent className="max-h-[85dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {displayedReview?.candidate
                ? "Connect these store products?"
                : "Separate this store product?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {displayedReview?.candidate
                ? "Confirm that every entry below is the same exact product. This saves a connection and replaces any earlier manual separation between these entries."
                : "This product will leave the group. Automatic matching will remember to keep it separate from the remaining entries. You can reconnect it manually later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="divide-y">
            {displayedReview?.candidate
              ? [
                  ...(data?.group?.members ?? []),
                  ...displayedReview.candidate.members,
                ].map((m) => <Member key={m.id} member={m} />)
              : displayedReview?.member && (
                  <Member member={displayedReview.member} />
                )}
          </div>
          {displayedReview?.candidate &&
            new Set(
              [
                ...(data?.group?.members ?? []),
                ...displayedReview.candidate.members,
              ].map((m) => m.retailer),
            ).size <
              (data?.group?.members.length ?? 0) +
                displayedReview.candidate.members.length && (
              <Badge variant="destructive">
                Two products from the same store — separate one first
              </Badge>
            )}
          <Field>
            <FieldLabel htmlFor={`${fieldId}-note`}>Note (optional)</FieldLabel>
            <Textarea
              id={`${fieldId}-note`}
              value={note}
              maxLength={data?.limits.max_note_length}
              disabled={saving}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why these products belong together, or why they differ"
            />
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <Button disabled={saving} onClick={() => void save()}>
              {saving
                ? "Saving…"
                : displayedReview?.candidate
                  ? "Save connection"
                  : "Separate and remember"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
