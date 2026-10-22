import { Search, RefreshCw, X } from "lucide-react";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { storeNames } from "@/app/_components/dashboard/types";
import type { DashboardQuery } from "@/nextsignal/domain/dashboard";
export function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value || "any"}
      onValueChange={(v) => onChange(v === "any" ? "" : v)}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map(([v, label]) => (
            <SelectItem key={v} value={v || "any"}>
              {label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
export function Filters({
  query,
  busy,
  onChange,
  onRefresh,
}: {
  query: DashboardQuery;
  busy: boolean;
  onChange: (patch: Partial<DashboardQuery>) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="filter-bar">
      <InputGroup className="search-input">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search"
          placeholder={
            query.view === "sources"
              ? "Search catalogs…"
              : query.view === "runs"
                ? "Search updates…"
                : query.view === "logs"
                  ? "Search log messages…"
                  : "Search product names…"
          }
          value={query.search}
          onChange={(e) => onChange({ search: e.target.value })}
        />
        {query.search && (
          <InputGroupAddon align="inline-end">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear search"
              onClick={() => onChange({ search: "" })}
            >
              <X />
            </Button>
          </InputGroupAddon>
        )}
      </InputGroup>
      {query.view !== "sources" && !query.source_id && (
        <Choice
          label="Store"
          value={query.retailer ?? ""}
          options={[["", "All stores"], ...Object.entries(storeNames)]}
          onChange={(retailer) => onChange({ retailer: retailer || undefined })}
        />
      )}
      {(query.view === "products" || query.view === "universal") && (
        <Choice
          label="Product names"
          value={query.name_quality ?? "named"}
          options={[
            ["named", "Valid product names"],
            ["invalid", "Names needing attention"],
            ["all", "All source records"],
          ]}
          onChange={(v) =>
            onChange({ name_quality: v as DashboardQuery["name_quality"] })
          }
        />
      )}
      {query.view === "universal" && (
        <Choice
          label="Matching status"
          value={query.match_filter ?? "all"}
          options={[
            ["all", "All matching statuses"],
            ["matched", "Matched across stores"],
            ["unmatched", "Single store only"],
          ]}
          onChange={(v) =>
            onChange({ match_filter: v as DashboardQuery["match_filter"] })
          }
        />
      )}
      {query.view === "runs" && (
        <>
          <Choice
            label="Update type"
            value={query.kind ?? ""}
            options={[
              ["", "All update types"],
              ["discover", "Catalog discovery"],
              ["catalog", "Price imports"],
              ["match", "Product matching"],
            ]}
            onChange={(v) =>
              onChange({ kind: (v as DashboardQuery["kind"]) || undefined })
            }
          />
          <Choice
            label="Update status"
            value={query.status ?? ""}
            options={[
              ["", "All statuses"],
              ["running", "In progress"],
              ["success", "Completed"],
              ["failed", "Failed"],
              ["quarantined", "Needs attention"],
              ["queued", "Queued"],
              ["pending", "Waiting"],
              ["superseded", "Replaced"],
            ]}
            onChange={(v) => onChange({ status: v || undefined })}
          />
        </>
      )}
      {query.view === "logs" && (
        <>
          <Choice
            label="Log level"
            value={query.level ?? ""}
            options={[
              ["", "All log levels"],
              ["debug", "Debug"],
              ["info", "Info"],
              ["warn", "Warning"],
              ["error", "Error"],
            ]}
            onChange={(v) => onChange({ level: v || undefined })}
          />
          {query.run_id && (
            <Button
              variant="outline"
              onClick={() => onChange({ run_id: undefined })}
            >
              This update only <X data-icon="inline-end" />
            </Button>
          )}
        </>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" disabled={busy} onClick={onRefresh}>
            <RefreshCw data-icon="inline-start" />
            {busy ? "Loading view…" : "Reload view"}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Reload displayed data. No imports or matching tasks are started.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
