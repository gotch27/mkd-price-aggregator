import { Pause, Play } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  number,
  type Summary,
  type TaskRequest,
} from "@/app/_components/dashboard/types";

export function MatchingProgress({
  summary,
  onReview,
}: {
  summary: Summary | null;
  onReview: (task: TaskRequest) => void;
}) {
  const status = summary?.matching;
  if (!status) return null;
  const campaign = status.campaigns.find((c) => c.state !== "completed");
  const paused = campaign?.state === "paused";
  const money = (value: string | number) => `$${Number(value).toFixed(2)}`;
  const control = (action: "pause" | "resume") =>
    onReview({
      endpoint: "/api/matching",
      body: { source_id: null, action },
      title: action === "pause" ? "Pause matching?" : "Resume matching?",
      scope: "Matching products across stores",
      effect:
        action === "pause"
          ? "Finish the current request and preserve all saved connections and progress."
          : "Continue unfinished work using the existing spending allowance. Completed products are not reset.",
      submitLabel: action === "pause" ? "Pause matching" : "Resume matching",
      successMessage:
        action === "pause"
          ? "Matching paused. Saved connections remain available."
          : "Matching resumed.",
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Matches across stores</CardTitle>
        <CardDescription>
          {!status.automatic_enabled
            ? "Automatic matching awaits our dataset evaluation."
            : (campaign?.reason ??
              "New and changed products are checked automatically.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-6">
        <div>
          <p className="text-sm text-muted-foreground">
            Connected store products
          </p>
          <p>{number(status.counts.matched)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Waiting</p>
          <p>
            {number(
              (status.work_counts.pending ?? 0) +
                (status.work_counts.running ?? 0),
            )}
          </p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Processed</p>
          <p>{number(status.work_counts.completed)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Deferred</p>
          <p>{number(status.work_counts.deferred)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Need more information</p>
          <p>
            {number(
              (status.counts.needs_info ?? 0) +
                (status.counts.no_candidates ?? 0) +
                (status.counts.legacy_conflict ?? 0),
            )}
          </p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Outside AI categories</p>
          <p>{number(status.counts.category_excluded)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">
            Categories selected for AI
          </p>
          <p>{number(status.ai_categories.length)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">
            Later updates this month
          </p>
          <p>
            {money(status.monthly_spent_usd)} /{" "}
            {money(status.monthly_budget_usd)}
          </p>
        </div>
        {campaign && (
          <div>
            <p className="text-sm text-muted-foreground">
              {campaign.kind === "initial"
                ? "Initial database pass"
                : "Current campaign"}
            </p>
            <p>
              {money(campaign.spent_usd)} / {money(campaign.budget_usd)}
            </p>
          </div>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap justify-between gap-3">
        <Badge variant="outline">
          {!status.automatic_enabled
            ? "Automatic matching off"
            : !status.indexing?.completed
              ? "Indexing store products"
              : paused
                ? "Paused"
                : campaign
                  ? "In progress"
                  : "Up to date"}
        </Badge>
        {campaign && (
          <Button
            variant="outline"
            size="sm"
            disabled={paused && !status.automatic_enabled}
            onClick={() => control(paused ? "resume" : "pause")}
          >
            {paused ? (
              <Play data-icon="inline-start" />
            ) : (
              <Pause data-icon="inline-start" />
            )}
            {paused ? "Resume" : "Pause"} matching
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
