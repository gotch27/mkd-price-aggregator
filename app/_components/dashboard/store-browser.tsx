import { ArrowRight, Files, Clock3, Store } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";
import { StoreLogo } from "@/app/_components/dashboard/store-logo";
import {
  text,
  number,
  type Summary,
  type DateFormatter,
} from "@/app/_components/dashboard/types";
const storeNotices: Record<string, string> = {
  spar: "Products with unclear source codes stay separate until their identity can be verified.",
  reptil:
    "Shared online catalog. Individual branch prices have not been verified.",
  stokomak:
    "Store timestamps may change during browsing. Import time is shown separately.",
  zito: "Store timestamps may change during browsing. Import time is shown separately.",
};
export function StoreBrowser({
  summary,
  date,
  onStore,
}: {
  summary: Summary | null;
  date: DateFormatter;
  onStore: (slug: string) => void;
}) {
  if (!summary)
    return (
      <div className="store-grid">
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} className="h-60" />
        ))}
      </div>
    );
  if (!summary.retailers.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Store />
          </EmptyMedia>
          <EmptyTitle>No stores yet</EmptyTitle>
          <EmptyDescription>
            Import store data from Data updates to start browsing catalogs.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <div className="store-grid">
      {summary.retailers.map((r) => (
        <Card key={text(r.slug)} className="store-card">
          <CardHeader>
            <StoreLogo slug={text(r.slug)} large />
            <CardAction>
              <Badge variant="outline">
                {number(r.sources)}{" "}
                {Number(r.sources) === 1 ? "catalog" : "catalogs"}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <h2 className="store-title">{text(r.name)}</h2>
            <p className="cell-note">{number(r.offers)} price observations</p>
            {Boolean(r.notice) && (
              <p className="store-notice">
                {storeNotices[text(r.slug)] ?? text(r.notice)}
              </p>
            )}
          </CardContent>
          <CardFooter>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock3 className="size-3" />
                Last imported
              </span>
              <span className="text-xs">{date(r.last_success)}</span>
            </div>
            <Button
              variant="outline"
              onClick={() => onStore(text(r.slug))}
              aria-label={`Browse ${text(r.name)} catalogs`}
            >
              Browse
              <ArrowRight data-icon="inline-end" />
            </Button>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
