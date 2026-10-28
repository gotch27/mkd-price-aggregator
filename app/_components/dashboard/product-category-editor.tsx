import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Pencil, Check, RotateCcw } from "lucide-react";
import type { CategoryEditView } from "@/nextsignal/domain/product-categories";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { ProductClassificationLabel } from "./product-classification";
import { taskApi } from "./task-api";
import { label, storeName } from "./types";

export function ProductCategoryEditor({
  id,
  memberId,
  onSaved,
  onUnauthorized,
  triggerLabel = "Change category",
}: {
  id: string;
  memberId: string;
  onSaved: () => void;
  onUnauthorized: () => void;
  triggerLabel?: string;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false),
    [data, setData] = useState<CategoryEditView | null>(null),
    [category, setCategory] = useState("unknown"),
    [note, setNote] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setData(null);
    setError("");
    setNote("");
    void taskApi<CategoryEditView>(
      `/api/products/${id}/category?member_id=${memberId}`,
      onUnauthorized,
      { signal: abort.signal },
    )
      .then((value) => {
        if (!abort.signal.aborted) {
          setData(value);
          setCategory(value.classification.category ?? "unknown");
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Could not load categories",
          );
      });
    return () => abort.abort();
  }, [open, id, memberId, onUnauthorized, reload]);
  async function save(action: "set" | "accept_suggestion" | "reset") {
    if (!data) return;
    setSaving(true);
    setError("");
    try {
      const result = await taskApi<{ category: string | null }>(
        `/api/products/${data.id}/category`,
        onUnauthorized,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            member_id: data.member_id,
            snapshot: data.classification.snapshot,
            action,
            category: action === "set" ? category : null,
            note,
          }),
        },
      );
      setOpen(false);
      toast.success(
        action === "accept_suggestion"
          ? "Suggested category approved"
          : action === "reset"
            ? "Reviewed category removed"
            : "Category saved",
        {
          description: result.category
            ? `Current category: ${label(result.category)}. The change is recorded in history.`
            : "The change is recorded in history.",
        },
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the category");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!saving) setOpen(value);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <Pencil data-icon="inline-start" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Product category</DialogTitle>
          <DialogDescription>
            {data
              ? `${storeName(data.retailer)} · ${data.name}`
              : "Choose a category or approve a model suggestion. Changes are saved without an AI call."}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Category was not saved</AlertTitle>
            <AlertDescription>
              {error}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setReload((v) => v + 1)}
                disabled={saving}
              >
                Reload
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {data ? (
          <>
            <ProductClassificationLabel classification={data.classification} />
            <FieldGroup>
              <Field data-disabled={saving}>
                <FieldLabel htmlFor={`${fieldId}-category`}>
                  Category
                </FieldLabel>
                <Select
                  value={category}
                  onValueChange={setCategory}
                  disabled={saving}
                >
                  <SelectTrigger id={`${fieldId}-category`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {data.categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Human, agent and LLM choices are kept through imports and
                  future AI runs until you change or remove them.
                </FieldDescription>
              </Field>
              <Field data-disabled={saving}>
                <FieldLabel htmlFor={`${fieldId}-note`}>
                  Note (optional)
                </FieldLabel>
                <Textarea
                  id={`${fieldId}-note`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={data.note_max_length}
                  disabled={saving}
                  rows={2}
                />
              </Field>
            </FieldGroup>
            {data.history.length > 0 && (
              <Accordion type="single" collapsible>
                <AccordionItem value="history">
                  <AccordionTrigger>
                    Category history ({data.history_total})
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="flex flex-col gap-3">
                      {data.history.map((entry) => (
                        <div key={entry.id}>
                          <p>
                            {entry.before_category
                              ? label(entry.before_category)
                              : "Not categorized"}{" "}
                            →{" "}
                            {entry.after_category
                              ? label(entry.after_category)
                              : "Not categorized"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {entry.action === "accept_suggestion"
                              ? "Approved suggestion"
                              : entry.action === "reset"
                                ? "Removed reviewed choice"
                                : entry.source === "llm"
                                  ? "LLM choice"
                                  : entry.source === "agent"
                                    ? "Agent choice"
                                    : "Human choice"}{" "}
                            · {entry.actor} ·{" "}
                            {new Date(entry.created_at).toLocaleString(
                              "en-GB",
                              { timeZone: data.timezone },
                            )}
                          </p>
                          {entry.note && (
                            <p className="text-sm">{entry.note}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}
            <DialogFooter className="flex-wrap gap-2">
              {data.classification.manual_category !== null && (
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() => void save("reset")}
                >
                  <RotateCcw data-icon="inline-start" />
                  Return to decision model
                </Button>
              )}
              {data.classification.can_accept_suggestion && (
                <Button
                  variant="secondary"
                  disabled={saving}
                  onClick={() => void save("accept_suggestion")}
                >
                  <Check data-icon="inline-start" />
                  Accept{" "}
                  {label(data.classification.suggested_category ?? "unknown")}
                </Button>
              )}
              <Button disabled={saving} onClick={() => void save("set")}>
                Save category
              </Button>
            </DialogFooter>
          </>
        ) : (
          !error && <Skeleton className="h-44 w-full" />
        )}
      </DialogContent>
    </Dialog>
  );
}
