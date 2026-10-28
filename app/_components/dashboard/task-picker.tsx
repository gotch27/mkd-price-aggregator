"use client";

import { Search, Download, Tags, Link2 } from "lucide-react";
import type { ReactNode } from "react";
import { TabsContent } from "@/components/ui/tabs";
import { WorkspaceSections } from "./workspace-sections";
import type { TaskKind } from "@/nextsignal/domain/task-settings";
import { taskLabels } from "./task-labels";

export const taskChoices = [
  {
    id: "discover",
    icon: Search,
    summary: "Find published catalog links.",
    detail: "Find the store’s catalogs without downloading product prices.",
  },
  {
    id: "import",
    icon: Download,
    summary: "Download products and prices.",
    detail: "Download and update complete product catalogs and their prices.",
  },
  {
    id: "categorize",
    icon: Tags,
    summary: "Assign product categories with AI.",
    detail:
      "Use AI to categorize imported products. This task does not connect products together.",
  },
  {
    id: "llm_review",
    icon: Tags,
    summary: "Review uncertain categories with Qwen.",
    detail:
      "Use the configured Qwen model to review available products left uncertain by the decision model. Unclear products remain in Review.",
  },
  {
    id: "match",
    icon: Link2,
    summary: "Connect the same product across stores.",
    detail:
      "Connect identical products from different stores. Code-only matching is the default.",
  },
] as const satisfies readonly {
  id: TaskKind;
  icon: typeof Search;
  summary: string;
  detail: string;
}[];

export function TaskPicker({
  value,
  onChange,
  children,
}: {
  value: TaskKind;
  onChange: (kind: TaskKind) => void;
  children: ReactNode;
}) {
  return (
    <WorkspaceSections
      sections={taskChoices.map((choice) => ({
        ...choice,
        label: taskLabels[choice.id],
        detail: choice.summary,
      }))}
      value={value}
      onChange={onChange}
      label="Tasks"
      selectionLabel="Task"
    >
      <TabsContent value={value}>{children}</TabsContent>
    </WorkspaceSections>
  );
}
