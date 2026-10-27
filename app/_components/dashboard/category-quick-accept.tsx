"use client";
import { useRef, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ProductClassification } from "@/nextsignal/domain/dashboard";
import { saveCategoryChoice } from "./category-actions";
import { label } from "./types";

export function QuickCategoryApproval({
  id,
  memberId,
  classification,
  onSaved,
  onUnauthorized,
}: {
  id: string;
  memberId: string;
  classification: ProductClassification;
  onSaved: () => void;
  onUnauthorized: () => void;
}) {
  const [busy, setBusy] = useState(false),
    inFlight = useRef(false);
  if (
    !classification.can_accept_suggestion ||
    !classification.suggested_category
  )
    return null;
  const title = `Confirm ${label(classification.suggested_category)}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon-xs"
          disabled={busy}
          aria-label={title}
          onClick={async (event) => {
            event.stopPropagation();
            if (inFlight.current) return;
            inFlight.current = true;
            setBusy(true);
            try {
              await saveCategoryChoice(
                {
                  id,
                  member_id: memberId,
                  snapshot: classification.snapshot,
                  action: "accept_suggestion",
                  category: null,
                  note: "",
                },
                onUnauthorized,
              );
              toast.success("Category confirmed");
              onSaved();
            } catch (error) {
              toast.error("Category was not saved", {
                description:
                  error instanceof Error ? error.message : "Try again.",
              });
            } finally {
              inFlight.current = false;
              setBusy(false);
            }
          }}
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <Check />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}
