"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Search,
  Tags,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardAction,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { storeNames } from "./types";
import { taskApi } from "./task-api";

import type {
  Brand,
  BrandPage,
  BrandOption,
  BrandInput,
} from "@/nextsignal/domain/brands";
type Alias = BrandInput["aliases"][number];

export function BrandFilter({
  value,
  onChange,
  onUnauthorized,
}: {
  value: string;
  onChange: (value: string) => void;
  onUnauthorized: () => void;
}) {
  const [rows, setRows] = useState<BrandOption[]>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void taskApi<{ rows: BrandOption[] }>(
      "/api/brands/options",
      onUnauthorized,
      { signal: abort.signal },
    )
      .then((result) => {
        setRows(result.rows);
        setError("");
      })
      .catch((cause) => {
        if (!abort.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "Could not load brands",
          );
      });
    return () => abort.abort();
  }, [onUnauthorized, revision]);
  if (error)
    return (
      <Button
        type="button"
        variant="outline"
        title={error}
        onClick={() => setRevision((v) => v + 1)}
      >
        Reload brands
      </Button>
    );
  return (
    <Select
      value={value || "all"}
      onValueChange={(next) => onChange(next === "all" ? "" : next)}
    >
      <SelectTrigger aria-label="Brand">
        <SelectValue placeholder="All brands" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="all">All brands</SelectItem>
          {value && !rows.some((row) => row.id === value) && (
            <SelectItem value={value}>Selected brand</SelectItem>
          )}
          {rows.map((brand) => (
            <SelectItem key={brand.id} value={brand.id}>
              {brand.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function BrandsManager({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<BrandPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Brand | "new" | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    void taskApi<BrandPage>(
      `/api/brands?${new URLSearchParams({ search: query, page: String(page), size: "30" })}`,
      onUnauthorized,
      { signal: abort.signal },
    )
      .then((data) => {
        setResult(data);
        setError("");
      })
      .catch((cause) => {
        if (!abort.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "Could not load brands",
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [query, page, revision, onUnauthorized]);
  function find() {
    setPage(1);
    setQuery(search.trim());
  }
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Brands</CardTitle>
          <CardDescription>
            One shared brand, with the different spellings used by stores. Brand
            changes save separately from automation settings.
          </CardDescription>
          <CardAction>
            <Button type="button" size="sm" onClick={() => setEditing("new")}>
              <Plus data-icon="inline-start" />
              Add brand
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search brands"
              placeholder="Search brands or spellings…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  find();
                }
              }}
            />
            <InputGroupAddon align="inline-end">
              <Button type="button" size="sm" variant="ghost" onClick={find}>
                Search
              </Button>
            </InputGroupAddon>
          </InputGroup>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Brands unavailable</AlertTitle>
              <AlertDescription>
                {error}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRevision((v) => v + 1)}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : loading ? (
            <div className="flex flex-col gap-3" aria-label="Loading brands">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : result?.rows.length ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Brand</TableHead>
                    <TableHead>Other spellings</TableHead>
                    <TableHead className="text-right">Products</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((brand) => (
                    <TableRow key={brand.id}>
                      <TableCell className="font-medium">
                        {brand.name}
                        {!brand.active && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            Retired
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="max-w-lg text-sm text-muted-foreground">
                          {brand.aliases
                            .map(
                              (alias) =>
                                `${alias.name}${alias.retailer ? ` (${storeNames[alias.retailer] ?? alias.retailer})` : ""}`,
                            )
                            .join(" · ") || "No additional spellings"}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {brand.product_count.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setEditing(brand)}
                          aria-label={`Edit ${brand.name}`}
                        >
                          <Pencil data-icon="inline-start" />
                          Edit
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                <span>
                  {result.total.toLocaleString()} brands · Page {result.page} of{" "}
                  {Math.max(1, result.total_pages)}
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={result.page <= 1}
                    onClick={() => setPage(result.page - 1)}
                  >
                    <ChevronLeft data-icon="inline-start" />
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={result.page >= result.total_pages}
                    onClick={() => setPage(result.page + 1)}
                  >
                    Next
                    <ChevronRight data-icon="inline-end" />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Tags />
                </EmptyMedia>
                <EmptyTitle>
                  {query ? "No matching brands" : "No brands yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {query
                    ? "Try another name or spelling."
                    : "Add a brand and the spellings stores use for it."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          <p className="text-sm text-muted-foreground">
            Shared brands help search and matching. A matching brand alone never
            connects products. Changes are recorded in the logs.
          </p>
        </CardContent>
      </Card>
      <BrandEditor
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        brand={editing}
        onUnauthorized={onUnauthorized}
        onClose={() => {
          setEditing(null);
          setRevision((v) => v + 1);
        }}
        onSaved={() => {
          setEditing(null);
          setRevision((v) => v + 1);
        }}
      />
    </>
  );
}

function BrandEditor({
  brand,
  onUnauthorized,
  onClose,
  onSaved,
}: {
  brand: Brand | "new" | null;
  onUnauthorized: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(brand && brand !== "new" ? brand.name : "");
  const [aliases, setAliases] = useState<Alias[]>(
    brand && brand !== "new"
      ? brand.aliases.map(({ name, retailer }) => ({ name, retailer }))
      : [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function update(index: number, change: Partial<Alias>) {
    setAliases((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...change } : row)),
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!brand || busy) return;
    setBusy(true);
    setError("");
    try {
      const existing = brand !== "new";
      await taskApi(
        existing ? `/api/brands/${brand.id}` : "/api/brands",
        onUnauthorized,
        {
          method: existing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            aliases: aliases.map((alias) => ({
              ...alias,
              name: alias.name.trim(),
            })),
            ...(existing ? { revision: brand.revision } : {}),
          }),
        },
      );
      toast.success(existing ? "Brand updated" : "Brand added");
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save brand");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={brand !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>
            {brand === "new" ? "Add brand" : "Edit brand"}
          </DialogTitle>
          <DialogDescription>
            Keep the brand name readable. Add only spellings that identify this
            brand; choose a store when a spelling is specific to it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="flex flex-col gap-5">
          <fieldset disabled={busy} className="min-w-0">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${id}-name`}>Brand name</FieldLabel>
                <Input
                  id={`${id}-name`}
                  value={name}
                  required
                  onChange={(event) => setName(event.target.value)}
                  autoFocus
                />
              </Field>
              <FieldSet>
                <FieldLegend>Other spellings</FieldLegend>
                <FieldDescription>
                  For example: Coca Cola, Кока Кола, KOKA KOLA.
                </FieldDescription>
                <FieldGroup>
                  {aliases.map((alias, index) => (
                    <FieldGroup
                      key={index}
                      className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                    >
                      <Field>
                        <FieldLabel
                          className="sr-only"
                          htmlFor={`${id}-alias-${index}`}
                        >
                          Spelling {index + 1}
                        </FieldLabel>
                        <Input
                          id={`${id}-alias-${index}`}
                          value={alias.name}
                          required
                          onChange={(event) =>
                            update(index, { name: event.target.value })
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel
                          className="sr-only"
                          id={`${id}-store-${index}`}
                        >
                          Store for spelling {index + 1}
                        </FieldLabel>
                        <Select
                          value={alias.retailer ?? "all"}
                          onValueChange={(retailer) =>
                            update(index, {
                              retailer: retailer === "all" ? null : retailer,
                            })
                          }
                        >
                          <SelectTrigger
                            aria-labelledby={`${id}-store-${index}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="all">All stores</SelectItem>
                              {Object.entries(storeNames).map(
                                ([slug, label]) => (
                                  <SelectItem key={slug} value={slug}>
                                    {label}
                                  </SelectItem>
                                ),
                              )}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove spelling ${index + 1}`}
                        onClick={() =>
                          setAliases((rows) =>
                            rows.filter((_, i) => i !== index),
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                    </FieldGroup>
                  ))}
                </FieldGroup>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setAliases((rows) => [
                      ...rows,
                      { name: "", retailer: null },
                    ])
                  }
                >
                  <Plus data-icon="inline-start" />
                  Add spelling
                </Button>
              </FieldSet>
            </FieldGroup>
          </fieldset>
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Brand wasn’t saved</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              <Check data-icon="inline-start" />
              {busy ? "Saving…" : "Save brand"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
