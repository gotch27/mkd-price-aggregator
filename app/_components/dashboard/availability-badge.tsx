import { Badge } from "@/components/ui/badge";
export function AvailabilityBadge({ value }: { value: unknown }) {
  return (
    <Badge
      variant={
        value === "available"
          ? "success"
          : value === "unknown"
            ? "warning"
            : "secondary"
      }
      title="Availability reported by the store, not independently verified stock"
    >
      {value === "available"
        ? "Available"
        : value === "unavailable"
          ? "Unavailable"
          : value === "not_listed"
            ? "Not currently listed"
            : "Availability unknown"}
    </Badge>
  );
}
