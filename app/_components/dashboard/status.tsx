import { Badge } from "@/components/ui/badge";
import {
  Check,
  CircleAlert,
  Clock3,
  Info,
  LoaderCircle,
  Bug,
  TriangleAlert,
  Link2,
} from "lucide-react";
const statuses = {
  category_excluded: {
    label: "Not selected for AI matching",
    variant: "outline",
    icon: Info,
  },
  needs_info: {
    label: "Not enough product information",
    variant: "outline",
    icon: Info,
  },
  no_candidates: {
    label: "No counterpart found",
    variant: "outline",
    icon: Link2,
  },
  deferred: { label: "Matching deferred", variant: "warning", icon: Clock3 },
  legacy_conflict: {
    label: "Existing group needs attention",
    variant: "warning",
    icon: TriangleAlert,
  },
  paused: { label: "Paused", variant: "secondary", icon: Clock3 },
  success: { label: "Completed", variant: "success", icon: Check },
  matched: { label: "Matched", variant: "success", icon: Link2 },
  fresh: { label: "Up to date", variant: "success", icon: Check },
  failed: { label: "Failed", variant: "destructive", icon: CircleAlert },
  quarantined: {
    label: "Needs attention",
    variant: "warning",
    icon: TriangleAlert,
  },
  running: { label: "In progress", variant: "info", icon: LoaderCircle },
  queued: { label: "Queued", variant: "secondary", icon: Clock3 },
  pending: { label: "Waiting", variant: "secondary", icon: Clock3 },
  superseded: { label: "Replaced", variant: "secondary", icon: Clock3 },
  separate: { label: "No match yet", variant: "outline", icon: Link2 },
  stale: { label: "Update due", variant: "warning", icon: Clock3 },
  debug: { label: "Debug", variant: "secondary", icon: Bug },
  info: { label: "Info", variant: "info", icon: Info },
  warn: { label: "Warning", variant: "warning", icon: TriangleAlert },
  error: { label: "Error", variant: "destructive", icon: CircleAlert },
} as const;
export function Status({ value }: { value: unknown }) {
  const status = statuses[String(value) as keyof typeof statuses];
  if (!status)
    return <Badge variant="outline">{String(value ?? "Unknown")}</Badge>;
  const Icon = status.icon;
  return (
    <Badge variant={status.variant}>
      <Icon data-icon="inline-start" />
      {status.label}
    </Badge>
  );
}
