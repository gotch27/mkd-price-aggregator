import {
  Store,
  Files,
  Package,
  Link2,
  Database,
  Clock3,
  Activity,
} from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
  CardAction,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StoreLogo } from "@/app/_components/dashboard/store-logo";
import {
  number,
  text,
  type Summary,
  type DateFormatter,
} from "@/app/_components/dashboard/types";
export function Overview({
  summary,
  date,
}: {
  summary: Summary | null;
  date: DateFormatter;
}) {
  if (!summary)
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
    );
  const c = summary.counts;
  const catalogs = summary.retailers.reduce(
    (sum, r) => sum + Number(r.sources),
    0,
  );
  const imported = summary.retailers.reduce(
    (sum, r) => sum + Number(r.imported),
    0,
  );
  const fresh = summary.retailers.reduce((sum, r) => sum + Number(r.fresh), 0);
  const metrics = [
    {
      title: "Stores",
      value: summary.retailers.length,
      note: "Supermarkets in your database",
      icon: Store,
    },
    {
      title: "Catalogs imported",
      value: imported,
      note: `Of ${number(catalogs)} discovered catalogs`,
      icon: Files,
    },
    {
      title: "Store products",
      value: c.catalog_items,
      note: "Distinct articles, without branch duplicates",
      icon: Package,
    },
    {
      title: "Universal products",
      value: c.universal_products,
      note: "Product identities across store catalogs",
      icon: Database,
    },
    {
      title: "Matched across stores",
      value: c.cross_store_products,
      note: "Universal products found in two or more stores",
      icon: Link2,
    },
    {
      title: "Updates in progress",
      value: c.pending,
      note: "Waiting, queued, or currently running",
      icon: Clock3,
    },
  ];
  return (
    <div className="flex flex-col gap-7">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {metrics.map((m) => (
          <Card key={m.title} className="metric-card">
            <CardHeader>
              <CardDescription>{m.title}</CardDescription>
              <CardAction>
                <m.icon className="size-4 text-muted-foreground" />
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className="metric-value">{number(m.value)}</div>
              <p className="metric-note">{m.note}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Catalog coverage</CardTitle>
            <CardDescription>Imported catalogs for each store</CardDescription>
            <CardAction>
              <Badge variant="outline">
                {number(imported)} / {number(catalogs)}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="coverage-grid grid grid-cols-2 gap-3 sm:grid-cols-3">
              {summary.retailers.map((r) => (
                <Card size="sm" className="min-w-0" key={text(r.slug)}>
                  <CardHeader className="flex flex-row items-center gap-2">
                    <StoreLogo slug={text(r.slug)} />
                    <CardTitle className="truncate">{text(r.name)}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p
                      className="text-lg font-medium tabular-nums"
                      aria-label={`${text(r.name)}: ${number(r.imported)} of ${number(r.sources)} catalogs imported`}
                    >
                      {number(r.imported)}
                      <span className="text-muted-foreground">
                        {" "}
                        / {number(r.sources)}
                      </span>
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle>Data freshness</CardTitle>
              <CardDescription>
                How current your catalog data is
              </CardDescription>
              <CardAction>
                <Activity className="size-4 text-muted-foreground" />
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className="metric-value">
                {number(fresh)}{" "}
                <span className="text-lg text-muted-foreground">
                  / {number(catalogs)}
                </span>
              </div>
              <p className="metric-note">
                Catalogs within the configured freshness window
              </p>
              <dl className="detail-fields mt-6">
                <div>
                  <dt>Browser index updated</dt>
                  <dd>{date(summary.refreshed_at)}</dd>
                </div>
                <div>
                  <dt>Index status</dt>
                  <dd>
                    {summary.refresh_pending
                      ? "New import awaiting indexing"
                      : "Up to date"}
                  </dd>
                </div>
                <div>
                  <dt>Current price observations</dt>
                  <dd>{number(c.offers)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Product matching</CardTitle>
              <CardDescription>
                Current matching coverage and usage
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="detail-fields">
                <div>
                  <dt>Matched across stores</dt>
                  <dd>{number(c.cross_store_products)}</dd>
                </div>
                <div>
                  <dt>Source names needing attention</dt>
                  <dd>{number(c.unnamed)}</dd>
                </div>
                <div>
                  <dt>Local matching</dt>
                  <dd>{summary.local_enabled ? "Enabled" : "Disabled"}</dd>
                </div>
                <div>
                  <dt>AI matching</dt>
                  <dd>{summary.ai_enabled ? "Enabled" : "Disabled"}</dd>
                </div>
                <div>
                  <dt>AI usage this month</dt>
                  <dd>
                    $
                    {summary.ai
                      .reduce((n, r) => n + Number(r.cost_usd), 0)
                      .toFixed(4)}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
