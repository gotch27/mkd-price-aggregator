import { Package, Link2, Layers3, Wallet } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
  CardAction,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { StoreLogo } from "@/app/_components/dashboard/store-logo";
import {
  number,
  text,
  type Summary,
  type AvailabilityCounts,
} from "@/app/_components/dashboard/types";

export function Overview({ summary }: { summary: Summary | null }) {
  if (!summary)
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-36" />
        ))}
      </div>
    );
  const counts = summary.counts;
  const stores = summary.retailers.map((store) => ({
    slug: text(store.slug),
    name: text(store.name),
    catalogs: Number(store.sources),
    imported: Number(store.imported),
    recent: Number(store.fresh),
    due: Math.max(0, Number(store.imported) - Number(store.fresh)),
    missing: Math.max(0, Number(store.sources) - Number(store.imported)),
  }));
  const catalogs = stores.reduce((sum, s) => sum + s.catalogs, 0),
    imported = stores.reduce((sum, s) => sum + s.imported, 0),
    recent = stores.reduce((sum, s) => sum + s.recent, 0),
    due = stores.reduce((sum, s) => sum + s.due, 0),
    missing = stores.reduce((sum, s) => sum + s.missing, 0);
  const availability = summary.retailers.map(
    (r) => r.availability_counts as AvailabilityCounts | null,
  );
  const availabilityKnown = availability.every((a) => a != null);
  const unavailable = availability.reduce(
      (sum, a) => sum + (a?.unavailable ?? 0),
      0,
    ),
    unknown = availability.reduce((sum, a) => sum + (a?.unknown ?? 0), 0);
  const windowValue =
    summary.freshness_hours % 24 === 0
      ? summary.freshness_hours / 24
      : summary.freshness_hours;
  const windowUnit = summary.freshness_hours % 24 === 0 ? "day" : "hour";
  const windowLabel = `${number(windowValue)} ${windowUnit}${windowValue === 1 ? "" : "s"}`;
  const metrics = [
    {
      title: "Available products",
      value:
        counts.available_store_products == null
          ? "—"
          : number(counts.available_store_products),
      note: "Unique per store, available in at least one branch.",
      icon: Package,
    },
    {
      title: "All listed products",
      value: counts.catalog_items == null ? "—" : number(counts.catalog_items),
      note: availabilityKnown
        ? `${number(unavailable)} unavailable${unknown ? ` · ${number(unknown)} availability unknown` : ""}`
        : "Includes products currently unavailable.",
      icon: Layers3,
    },
    {
      title: "Matched across stores",
      value: number(counts.cross_store_products),
      note: "Shared products found in two or more stores.",
      icon: Link2,
    },
    {
      title: "AI usage this month",
      value: `$${summary.ai.reduce((sum, row) => sum + Number(row.cost_usd), 0).toFixed(4)}`,
      note: `AI permission ${summary.ai_enabled ? "on" : "off"}. Runs are controlled in Run Tasks.`,
      icon: Wallet,
    },
  ];
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <Card key={metric.title} className="metric-card">
            <CardHeader>
              <CardDescription>{metric.title}</CardDescription>
              <CardAction>
                <metric.icon className="size-4 text-muted-foreground" />
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className="metric-value">{metric.value}</div>
              <p className="metric-note">{metric.note}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Catalog coverage</CardTitle>
          <CardDescription>
            Imports within the last {windowLabel} count as recent.
          </CardDescription>
          <CardAction>
            <p className="text-lg font-semibold tabular-nums">
              {number(imported)} / {number(catalogs)}
            </p>
            <p className="text-xs text-muted-foreground">catalogs imported</p>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-3 gap-4">
            {[
              { label: "Recent imports", value: recent },
              { label: "Need refresh", value: due },
              { label: "Not imported", value: missing },
            ].map((metric) => (
              <div key={metric.label}>
                <dt className="text-xs text-muted-foreground">
                  {metric.label}
                </dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums">
                  {number(metric.value)}
                </dd>
              </div>
            ))}
          </dl>
          <Separator />
          <div className="coverage-grid grid grid-cols-2 gap-3 sm:grid-cols-3">
            {stores.map((store) => {
              const status = [
                store.recent > 0 ? `${number(store.recent)} recent` : null,
                store.due > 0 ? `${number(store.due)} need refresh` : null,
                store.missing > 0
                  ? `${number(store.missing)} not imported`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <Card size="sm" className="min-w-0" key={text(store.slug)}>
                  <CardHeader className="flex flex-row items-center gap-2">
                    <StoreLogo slug={text(store.slug)} />
                    <CardTitle className="truncate">
                      {text(store.name)}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p
                      className="text-lg font-medium tabular-nums"
                      aria-label={`${text(store.name)}: ${number(store.imported)} of ${number(store.catalogs)} catalogs imported`}
                    >
                      {number(store.imported)}
                      <span className="text-muted-foreground">
                        {" "}
                        / {number(store.catalogs)}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {status || "No catalogs yet"}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          {summary.statistics_pending && (
            <p role="status" className="text-xs text-muted-foreground">
              Totals are being refreshed. Showing the last saved counts.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
