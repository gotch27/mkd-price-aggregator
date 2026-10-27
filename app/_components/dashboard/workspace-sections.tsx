"use client";
import { useId, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";

type Section<T extends string> = {
  id: T;
  label: string;
  detail: string;
  icon: LucideIcon;
};

export function WorkspaceSections<T extends string>({
  sections,
  value,
  onChange,
  label,
  selectionLabel,
  children,
}: {
  sections: readonly Section<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  selectionLabel: string;
  children: ReactNode;
}) {
  const selectId = useId();
  function select(next: string) {
    if (sections.some((section) => section.id === next)) onChange(next as T);
  }
  return (
    <Tabs
      orientation="vertical"
      value={value}
      onValueChange={select}
      className="workspace-sections"
    >
      <TabsList
        variant="navigation"
        className="workspace-section-nav"
        aria-label={label}
      >
        {sections.map((section) => (
          <TabsTrigger key={section.id} value={section.id}>
            <section.icon />
            <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
              <span>{section.label}</span>
              <span className="workspace-section-description">
                {section.detail}
              </span>
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
      <Field className="workspace-section-select">
        <FieldLabel htmlFor={selectId}>{selectionLabel}</FieldLabel>
        <Select value={value} onValueChange={select}>
          <SelectTrigger id={selectId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {sections.map((section) => (
                <SelectItem key={section.id} value={section.id}>
                  {section.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <div className="min-w-0">{children}</div>
    </Tabs>
  );
}
