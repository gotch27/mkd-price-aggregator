"use client";
import type { ReactNode } from "react";
import { RefreshCw, ScrollText } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { ObservabilityTab } from "./navigation-state";
export function ObservabilityTabs({
  tab,
  onChange,
  children,
}: {
  tab: ObservabilityTab;
  onChange: (tab: ObservabilityTab) => void;
  children: ReactNode;
}) {
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (value === "updates" || value === "logs") onChange(value);
      }}
      className="gap-4"
    >
      <TabsList variant="line" aria-label="Observability views">
        <TabsTrigger value="updates">
          <RefreshCw />
          Data updates
        </TabsTrigger>
        <TabsTrigger value="logs">
          <ScrollText />
          Logs
        </TabsTrigger>
      </TabsList>
      <TabsContent value={tab}>{children}</TabsContent>
    </Tabs>
  );
}
