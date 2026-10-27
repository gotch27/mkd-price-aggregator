import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { readableProductText } from "@/nextsignal/domain/product-text";
import { Pencil, RotateCcw, Save, LoaderCircle } from "lucide-react";
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
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import {
  productFields,
  type EditableProduct,
  type DetailOverrides,
} from "@/nextsignal/domain/product-edits";
import {
  storeName,
  type DateFormatter,
} from "@/app/_components/dashboard/types";

export function ProductDetailsEditor({
  id,
  memberId,
  date,
  onSaved,
  onUnauthorized,
}: {
  id: string;
  memberId: string;
  date: DateFormatter;
  onSaved: () => void;
  onUnauthorized: () => void;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<EditableProduct | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("details");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setData(null);
    setError("");
    setNote("");
    setTab("details");
    void (async () => {
      try {
        const response = await fetch(
          `/api/products/${id}/attributes?member_id=${memberId}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (response.status === 401) {
          onUnauthorized();
          return;
        }
        const result = await response.json();
        if (!result.ok)
          throw new Error(
            result.errors?.[0]?.message ?? "Unable to load editable details",
          );
        if (controller.signal.aborted) return;
        const value: EditableProduct = result.data;
        setData(value);
        setDraft(
          Object.fromEntries(
            productFields.map(([key]) => [key, value.facts[key]?.value ?? ""]),
          ),
        );
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Unable to load editable details",
          );
      }
    })();
    return () => controller.abort();
  }, [open, id, memberId, onUnauthorized, reload]);
  const changes: DetailOverrides = {};
  if (data)
    for (const [key] of productFields) {
      const value = (draft[key] ?? "").trim();
      if (value !== (data.facts[key]?.value ?? ""))
        changes[key] = value || null;
    }
  async function submit(action: "update" | "reset") {
    if (!data || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/products/${id}/attributes`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          member_id: data.member_id,
          snapshot: data.snapshot,
          action,
          changes: action === "reset" ? {} : changes,
          note,
        }),
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      const result = await response.json();
      if (!result.ok)
        throw new Error(
          result.errors?.[0]?.message ?? "Unable to save product details",
        );
      setOpen(false);
      toast.success(
        action === "reset" ? "Store details restored" : "Product details saved",
        {
          description: "The change is recorded in the edit history.",
        },
      );
      onSaved();
    } catch (e) {
      toast.error("Unable to save details", {
        description:
          e instanceof Error ? e.message : "Unable to save product details",
      });
    } finally {
      setSaving(false);
    }
  }
  function fields(items: (typeof productFields)[number][]) {
    return (
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        {items.map(([key, label]) => (
          <Field key={key} data-disabled={saving}>
            <FieldLabel htmlFor={`${fieldId}-${key}`}>
              {label}
              {Object.hasOwn(data?.overrides ?? {}, key) && (
                <Badge variant="secondary">Edited</Badge>
              )}
            </FieldLabel>
            {key === "unit" ? (
              <Select
                value={draft.unit || "unknown"}
                onValueChange={(value) =>
                  setDraft((d) => ({
                    ...d,
                    unit: value === "unknown" ? "" : value,
                  }))
                }
                disabled={saving}
              >
                <SelectTrigger id={`${fieldId}-${key}`} aria-label="Unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {[
                      ["unknown", "Not provided"],
                      ["g", "g"],
                      ["kg", "kg"],
                      ["ml", "ml"],
                      ["l", "l"],
                      ["piece", "piece"],
                    ].map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={`${fieldId}-${key}`}
                value={draft[key] ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [key]: e.target.value }))
                }
                disabled={saving}
                maxLength={data?.limits.value_max_length}
                placeholder="Not provided"
                inputMode={
                  ["quantity", "pack", "fat", "alcohol"].includes(key)
                    ? "decimal"
                    : key === "gtin"
                      ? "numeric"
                      : "text"
                }
              />
            )}
          </Field>
        ))}
      </FieldGroup>
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!saving) setOpen(value);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil data-icon="inline-start" />
          Edit details
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!saving}
      >
        <DialogHeader>
          <DialogTitle>Edit product details</DialogTitle>
          <DialogDescription>
            {data
              ? `${storeName(data.retailer)} · ${readableProductText(data.name, data.retailer)}`
              : "Loading store product…"}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Unable to save details</AlertTitle>
            <AlertDescription>
              {error}
              {!data && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setReload((n) => n + 1)}
                >
                  Try again
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        {!data && !error && (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-48" />
          </div>
        )}
        {data && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit("update");
            }}
          >
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="history">
                  Edit history ({data.history_total})
                </TabsTrigger>
              </TabsList>
              <TabsContent value="details" className="py-4">
                <div className="flex flex-col gap-4">
                  <p className="text-sm text-muted-foreground">
                    Corrections apply across this store’s branches and survive
                    repeat imports. Clear a field to mark it unknown. Original
                    store information and prices are kept.
                  </p>
                  {fields(productFields.slice(0, 8))}
                  <Accordion type="single" collapsible>
                    <AccordionItem value="more">
                      <AccordionTrigger>More product details</AccordionTrigger>
                      <AccordionContent>
                        {fields(productFields.slice(8))}
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                  <FieldGroup>
                    <Field data-disabled={saving}>
                      <FieldLabel htmlFor={`${fieldId}-note`}>
                        Reason for change (optional)
                      </FieldLabel>
                      <Textarea
                        id={`${fieldId}-note`}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        maxLength={data.limits.note_max_length}
                        disabled={saving}
                        rows={2}
                      />
                      <FieldDescription>
                        Your name, time and changed values are saved in the edit
                        history. Saving makes no AI call.
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                </div>
              </TabsContent>
              <TabsContent value="history" className="py-4">
                {data.history.length ? (
                  <div className="flex flex-col gap-5">
                    {data.history.map((edit) => (
                      <section key={edit.id} className="flex flex-col gap-2">
                        <div>
                          <p className="text-sm font-medium">
                            {edit.actor} ·{" "}
                            {edit.action === "reset"
                              ? "Restored store details"
                              : "Edited details"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {date(edit.created_at)}
                          </p>
                        </div>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Detail</TableHead>
                              <TableHead>Before</TableHead>
                              <TableHead>After</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {edit.changes.map((change) => (
                              <TableRow key={change.field}>
                                <TableCell>
                                  {productFields.find(
                                    ([key]) => key === change.field,
                                  )?.[1] ?? change.field}
                                </TableCell>
                                <TableCell>
                                  {change.before ?? "Not provided"}
                                </TableCell>
                                <TableCell>
                                  {change.after ?? "Not provided"}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                        {edit.note && (
                          <p className="text-sm text-muted-foreground">
                            {edit.note}
                          </p>
                        )}
                      </section>
                    ))}
                    {data.history_total > data.history.length && (
                      <p className="text-sm text-muted-foreground">
                        Showing the latest {data.history.length} edits. All{" "}
                        {data.history_total} edits remain saved.
                      </p>
                    )}
                  </div>
                ) : (
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>No manual edits yet</EmptyTitle>
                      <EmptyDescription>
                        Saved changes will appear here with their author and
                        time.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </TabsContent>
            </Tabs>
            <DialogFooter>
              {tab === "details" && Object.keys(data.overrides).length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void submit("reset")}
                >
                  <RotateCcw data-icon="inline-start" />
                  Restore store details
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              {tab === "details" && (
                <Button
                  type="submit"
                  disabled={saving || !Object.keys(changes).length}
                >
                  {saving ? (
                    <LoaderCircle
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : (
                    <Save data-icon="inline-start" />
                  )}
                  Save changes
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
