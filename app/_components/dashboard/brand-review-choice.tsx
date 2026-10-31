"use client";
import { useEffect, useId, useState } from "react";
import { Check, SkipForward } from "lucide-react";
import type { Brand, BrandPage } from "@/nextsignal/domain/brands";
import type {
  BrandReviewItem,
  BrandReviewDecision,
} from "@/nextsignal/domain/brand-review";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { taskApi } from "./task-api";
import { storeName, number } from "./types";

export function BrandReviewChoice({
  item,
  busy,
  size,
  onUnauthorized,
  onSubmit,
}: {
  item: BrandReviewItem;
  busy: boolean;
  size: number;
  onUnauthorized: () => void;
  onSubmit: (decision: BrandReviewDecision) => Promise<void>;
}) {
  const id = useId();
  const [mode, setMode] = useState("existing"),
    [search, setSearch] = useState(item.term),
    [rows, setRows] = useState<Brand[]>([]),
    [selected, setSelected] = useState(""),
    [name, setName] = useState(""),
    [exampleId, setExampleId] = useState(item.examples[0]?.id ?? ""),
    [alias, setAlias] = useState(item.examples[0]?.quote ?? ""),
    [reason, setReason] = useState(
      "Confirmed brand spelling in the source name",
    ),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void taskApi<BrandPage>(
      `/api/brands?${new URLSearchParams({ search, page: "1", size: String(size) })}`,
      onUnauthorized,
      { signal: controller.signal },
    )
      .then((result) => {
        setRows(result.rows);
        setError("");
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load brands");
      });
    return () => controller.abort();
  }, [search, onUnauthorized, size]);
  const example = item.examples.find((e) => e.id === exampleId);
  const brand = rows.find((b) => b.id === selected);
  const canSave =
    !!example &&
    !!alias.trim() &&
    !!reason.trim() &&
    (mode === "new" ? !!name.trim() : !!brand);
  async function submit(action: "save" | "skip") {
    await onSubmit({
      item_id: item.id,
      snapshot: item.input_key,
      action,
      brand_id:
        action === "save" && mode === "existing" ? (brand?.id ?? null) : null,
      brand_revision:
        action === "save" && mode === "existing"
          ? (brand?.revision ?? null)
          : null,
      name: action === "save" && mode === "new" ? name : null,
      aliases:
        action === "save" && example
          ? [
              {
                name: alias,
                retailer: example.retailer,
                evidence: [
                  { member_id: example.id, field: example.field, quote: alias },
                ],
              },
            ]
          : [],
      reason:
        action === "skip"
          ? reason.trim() &&
            reason !== "Confirmed brand spelling in the source name"
            ? reason
            : "Source does not establish this term as a brand"
          : reason,
    });
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Review “{item.term}”</CardTitle>
        <CardDescription>
          Seen in {number(item.affected)} unique products in this sample. Check
          whether it is a brand, product line, or generic wording.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-3 md:grid-cols-2">
          {item.examples.map((e) => (
            <div key={e.id} className="rounded-lg border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">
                {storeName(e.retailer)}
              </p>
              <p className="font-medium">{e.readable_name}</p>
              {e.name !== e.readable_name && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Source: {e.name}
                </p>
              )}
              {e.description && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {e.description}
                </p>
              )}
              <p className="mt-2 text-sm">
                Source spelling: <strong>{e.quote}</strong>
              </p>
            </div>
          ))}
        </div>
        <Tabs value={mode} onValueChange={setMode}>
          <TabsList aria-label="Brand action">
            <TabsTrigger value="existing">Existing brand</TabsTrigger>
            <TabsTrigger value="new">New brand</TabsTrigger>
          </TabsList>
        </Tabs>
        <FieldGroup className="grid gap-4 md:grid-cols-2">
          {mode === "existing" ? (
            <>
              <Field>
                <FieldLabel htmlFor={`${id}-search`}>Find a brand</FieldLabel>
                <Input
                  id={`${id}-search`}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setSelected("");
                  }}
                  placeholder="Search canonical name or spelling"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-brand`}>Canonical brand</FieldLabel>
                <Select value={selected} onValueChange={setSelected}>
                  <SelectTrigger id={`${id}-brand`}>
                    <SelectValue placeholder="Choose an existing brand" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {rows.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.name}
                          {!b.active ? " (retired)" : ""}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {error ||
                    (!rows.length
                      ? "No brand found. Check another spelling before creating one."
                      : brand
                        ? `${brand.aliases.length} saved spellings`
                        : "Choose the brand this spelling belongs to.")}
                </FieldDescription>
              </Field>
            </>
          ) : (
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>
                Canonical brand name
              </FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Readable brand name"
              />
              <FieldDescription>
                A display name does not create a global spelling automatically.
              </FieldDescription>
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor={`${id}-source`}>Source example</FieldLabel>
            <Select
              value={exampleId}
              onValueChange={(v) => {
                setExampleId(v);
                setAlias(item.examples.find((e) => e.id === v)?.quote ?? "");
              }}
            >
              <SelectTrigger id={`${id}-source`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {item.examples.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {storeName(e.retailer)} · {e.quote}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-alias`}>Exact spelling</FieldLabel>
            <Input
              id={`${id}-alias`}
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
            />
            <FieldDescription>
              Copy only the brand text from the original source. Applies to{" "}
              {example ? storeName(example.retailer) : "this store"}.
            </FieldDescription>
          </Field>
          <Field className="md:col-span-2">
            <FieldLabel htmlFor={`${id}-reason`}>Reason</FieldLabel>
            <Input
              id={`${id}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter className="flex flex-wrap justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Saved as Human. Local brand facts refresh without AI or matching.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void submit("skip")}
          >
            <SkipForward />
            Skip
          </Button>
          <Button
            disabled={busy || !canSave}
            onClick={() => void submit("save")}
          >
            <Check />
            Save and next
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
