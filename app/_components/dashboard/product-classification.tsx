import type { ProductClassification } from "@/nextsignal/domain/dashboard";
import { Badge } from "@/components/ui/badge";
import { label } from "./types";
import type { ReactNode } from "react";

const percent = (value: number) =>
  `${(value * 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}%`;
export function ProductClassificationLabel({
  classification,
  suggestionAction,
}: {
  classification?: ProductClassification;
  suggestionAction?: ReactNode;
}) {
  const state = classification?.state ?? "not_categorized";
  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Category</span>
        <Badge
          variant={
            state === "assigned" ||
            state === "manual" ||
            state === "agent" ||
            state === "llm"
              ? "success"
              : state === "not_categorized"
                ? "secondary"
                : "warning"
          }
        >
          {state === "not_categorized"
            ? "Not categorized"
            : state === "outdated"
              ? "Needs recategorization"
              : label(classification?.category ?? "unknown")}
        </Badge>
        {state === "assigned" &&
          classification?.probability !== null &&
          classification?.probability !== undefined && (
            <span className="text-xs text-muted-foreground">
              {percent(classification.probability)} model probability
            </span>
          )}
      </div>
      {(state === "manual" || state === "agent" || state === "llm") && (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>
            {state === "llm"
              ? "Selected by LLM"
              : state === "agent"
                ? "Selected by Agent"
                : "Confirmed by Human"}
            {classification?.reviewed_by
              ? ` · ${classification.reviewed_by}`
              : ""}
            {classification?.reviewed_at
              ? ` · ${new Date(classification.reviewed_at).toLocaleDateString("en-GB")}`
              : ""}
          </span>
          {classification?.review_reason && (
            <span>{classification.review_reason}</span>
          )}
        </div>
      )}
      {state === "uncertain" && classification && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            Needs review.
            {classification.suggested_category &&
            classification.suggested_category !== "unknown"
              ? ` Suggested: ${label(classification.suggested_category)}.`
              : ""}
          </span>
          {suggestionAction}
          <span>
            {classification.probability !== null
              ? ` Model probability: ${percent(classification.probability)}.`
              : ""}
            {classification.threshold !== null
              ? ` Required: ${percent(classification.threshold)}.`
              : ""}
          </span>
        </div>
      )}
      {state === "outdated" && (
        <p className="text-xs text-muted-foreground">
          This category needs to be checked again.
          {classification?.category
            ? ` Previous category: ${label(classification.category)}.`
            : ""}
        </p>
      )}
    </div>
  );
}
