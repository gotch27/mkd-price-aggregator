"use client";
import { useState, useEffect, useId } from "react";
import { toast } from "sonner";
import type {
  OperationalPolicy,
  TaskSettingsView,
} from "@/nextsignal/domain/task-settings";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Workflow,
  CalendarClock,
  Link2,
  Wallet,
  SlidersHorizontal,
  Tags,
} from "lucide-react";
import { taskApi } from "./task-api";

import { WorkspaceSections } from "./workspace-sections";
import { PageActions } from "./page-actions";
import { TaskSettingsHistory } from "./task-settings-history";
import { BrandsManager } from "./brands-manager";

export function CategoryChoices({
  categories,
  selected,
  onChange,
  id,
  description,
  disabled,
}: {
  categories: TaskSettingsView["categories"];
  selected: string[];
  onChange: (values: string[]) => void;
  id: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <FieldSet disabled={disabled}>
      <FieldLegend>AI comparison categories</FieldLegend>
      <FieldDescription>
        {description ??
          "Counts show saved categories for available products across all stores. Code-based matching is available in every category."}
      </FieldDescription>
      <FieldGroup className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((c) => (
          <Field key={c.id} orientation="horizontal" data-disabled={disabled}>
            <Checkbox
              id={`${id}-${c.id}`}
              disabled={disabled}
              checked={selected.includes(c.id)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...selected, c.id]
                    : selected.filter((v) => v !== c.id),
                )
              }
            />
            <FieldLabel htmlFor={`${id}-${c.id}`}>
              {c.name}{" "}
              <span className="text-muted-foreground">
                ({c.count.toLocaleString()})
              </span>
            </FieldLabel>
          </Field>
        ))}
      </FieldGroup>
    </FieldSet>
  );
}
const sections = [
  {
    id: "automation",
    label: "Automation",
    detail: "When work can run",
    icon: Workflow,
  },
  {
    id: "schedule",
    label: "Import schedule",
    detail: "Times and stores",
    icon: CalendarClock,
  },
  {
    id: "matching",
    label: "Matching & AI",
    detail: "Permissions and categories",
    icon: Link2,
  },
  {
    id: "spending",
    label: "Spending",
    detail: "Allowances and request caps",
    icon: Wallet,
  },
  {
    id: "brands",
    label: "Brands",
    detail: "Names and store spellings",
    icon: Tags,
  },
  {
    id: "advanced",
    label: "Advanced",
    detail: "Worker limits and thresholds",
    icon: SlidersHorizontal,
  },
] as const;
type Section = (typeof sections)[number]["id"];
type NumberKey = {
  [K in keyof OperationalPolicy]: OperationalPolicy[K] extends number
    ? K
    : never;
}[keyof OperationalPolicy];
const schedulePreset = (cron: string) =>
  cron === "0 12 * * *" ? "daily" : cron === "0 12 * * 1" ? "weekly" : "custom";
const money = (value: number) =>
  Number.isFinite(value) ? `$${value.toFixed(2)}` : "—";

export function TaskSettingsForm({
  actionsTarget,
  saved,
  onSaved,
  onUnauthorized,
}: {
  actionsTarget: HTMLElement | null;
  saved: TaskSettingsView;
  onSaved: () => void;
  onUnauthorized: () => void;
}) {
  const formId = useId();
  const [section, setSection] = useState<Section>("automation");
  const [base, setBase] = useState(saved.revision),
    [initial, setInitial] = useState(saved.policy),
    [draft, setDraft] = useState(saved.policy);
  const [nextRuns, setNextRuns] = useState(saved.next_runs),
    [cronError, setCronError] = useState("");
  const [preset, setPreset] = useState(schedulePreset(saved.policy.cron));
  const [busy, setBusy] = useState(false);
  const [activateBacklog, setActivateBacklog] = useState(false);
  const dirty =
    JSON.stringify(initial) !== JSON.stringify(draft) || activateBacklog;
  useEffect(() => {
    if (saved.revision <= base || dirty) return;
    setBase(saved.revision);
    setInitial(saved.policy);
    setDraft(saved.policy);
    setPreset(schedulePreset(saved.policy.cron));
  }, [saved.revision, saved.policy, base, dirty]);
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void taskApi<{ next_runs: string[] }>(
        `/api/task-settings/schedule?cron=${encodeURIComponent(draft.cron)}`,
        onUnauthorized,
        { signal: abort.signal },
      )
        .then((result) => {
          setNextRuns(result.next_runs);
          setCronError("");
        })
        .catch((e) => {
          if (!abort.signal.aborted) setCronError(e.message);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [draft.cron, onUnauthorized]);
  const set = <K extends keyof OperationalPolicy>(
    key: K,
    value: OperationalPolicy[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (key === "categorization")
      setActivateBacklog(
        value === "automatic" && !saved.category_backlog_active,
      );
  };
  function reset() {
    setActivateBacklog(false);
    setDraft(saved.policy);
    setInitial(saved.policy);
    setBase(saved.revision);
    setPreset(schedulePreset(saved.policy.cron));
  }
  function numeric(
    key: NumberKey,
    title: string,
    options: {
      percent?: boolean;
      min?: number;
      max?: number;
      step?: string;
    } = {},
  ) {
    const value = draft[key] * (options.percent ? 100 : 1);
    const invalid =
      !Number.isFinite(value) ||
      (options.min !== undefined && value < options.min) ||
      (options.max !== undefined && value > options.max);
    return (
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor={`setting-${key}`}>{title}</FieldLabel>
        <Input
          id={`setting-${key}`}
          type="number"
          min={options.min ?? 0}
          max={options.max}
          step={options.step ?? "1"}
          required
          aria-invalid={invalid}
          value={Number.isNaN(value) ? "" : value}
          onChange={(e) =>
            set(key, e.target.valueAsNumber / (options.percent ? 100 : 1))
          }
        />
      </Field>
    );
  }
  function toggle(
    key: "ai_enabled" | "clarification_enabled" | "catch_up",
    title: string,
    description: string,
  ) {
    return (
      <Field orientation="horizontal">
        <Switch
          id={`setting-${key}`}
          checked={draft[key]}
          disabled={key === "ai_enabled" && !saved.key_ready}
          onCheckedChange={(value) => set(key, value)}
        />
        <div>
          <FieldLabel htmlFor={`setting-${key}`}>{title}</FieldLabel>
          <FieldDescription>{description}</FieldDescription>
        </div>
      </Field>
    );
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await taskApi<{
        revision: number;
        policy: OperationalPolicy;
      }>("/api/task-settings", onUnauthorized, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision: base,
          policy: draft,
          authorize_category_backlog:
            activateBacklog && draft.categorization === "automatic",
        }),
      });
      setBase(result.revision);
      setInitial(result.policy);
      setDraft(result.policy);
      setActivateBacklog(false);
      toast.success("Settings saved", {
        description: "Your changes have been saved.",
      });
      onSaved();
    } catch (e) {
      toast.error("Settings weren’t saved", {
        description: e instanceof Error ? e.message : "Could not save settings",
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form id={formId} onSubmit={save} className="settings-form">
      <PageActions target={actionsTarget}>
        <TaskSettingsHistory
          revision={saved.revision}
          timezone={saved.timezone}
          onUnauthorized={onUnauthorized}
        />
        {(dirty || busy) && (
          <>
            <span className="sr-only" aria-live="polite">
              Unsaved settings changes
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={reset}
            >
              Discard
            </Button>
            <Button
              type="submit"
              form={formId}
              size="sm"
              disabled={busy || !!cronError}
            >
              {busy
                ? "Saving…"
                : activateBacklog
                  ? "Activate automatic categorization"
                  : "Save changes"}
            </Button>
          </>
        )}
      </PageActions>
      <fieldset disabled={busy} aria-label="Task settings" className="min-w-0">
        <WorkspaceSections
          sections={sections}
          value={section}
          onChange={setSection}
          label="Settings sections"
          selectionLabel="Settings section"
        >
          <TabsContent value="automation">
            <Card>
              <CardHeader>
                <CardTitle>When tasks can run</CardTitle>
                <CardDescription>
                  Choose each operation independently. Automatic categorization
                  keeps available products categorized, including the existing
                  backlog after activation. Paused tasks stay held.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  {(
                    [
                      [
                        "imports",
                        "Price imports",
                        "Download and publish prices from store catalogs.",
                      ],
                      [
                        "categorization",
                        "Product categorization",
                        "Categorize available products that still need a saved category, then keep up with new or changed products.",
                      ],
                      [
                        "matching",
                        "Product matching",
                        "Connect the same products across different stores.",
                      ],
                    ] as const
                  ).map(([key, title, description]) => (
                    <Field key={key} className="settings-mode-field">
                      <div>
                        <FieldLabel id={`mode-${key}`}>{title}</FieldLabel>
                        <FieldDescription>{description}</FieldDescription>
                      </div>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        value={draft[key]}
                        onValueChange={(value) => {
                          if (value)
                            set(key, value as OperationalPolicy[typeof key]);
                        }}
                        aria-labelledby={`mode-${key}`}
                        className="flex-wrap justify-start"
                      >
                        <ToggleGroupItem value="off">Off</ToggleGroupItem>
                        <ToggleGroupItem value="manual">
                          Manual only
                        </ToggleGroupItem>
                        <ToggleGroupItem value="automatic">
                          Automatic
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </Field>
                  ))}
                </FieldGroup>
                {draft.categorization === "automatic" &&
                  !saved.category_backlog_active && (
                    <Alert className="mt-4">
                      <AlertTitle>
                        {activateBacklog
                          ? "Review automatic categorization before saving"
                          : "Backlog processing needs activation"}
                      </AlertTitle>
                      <AlertDescription>
                        Existing available products will be processed in tasks
                        of {draft.default_product_limit}, with a $
                        {draft.task_budget_usd.toFixed(2)} total allowance per
                        task and your shared spending limits. Saved categories,
                        human and agent choices, paused tasks and deferred
                        requests are preserved.
                        {activateBacklog ? (
                          <p>
                            Use “Activate automatic categorization” above to
                            save and allow background processing.
                          </p>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setActivateBacklog(true)}
                          >
                            Review activation
                          </Button>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}
                {draft.categorization === "automatic" && (
                  <p className="settings-help">
                    Temporary Gateway failures use a cooldown starting at{" "}
                    {saved.gateway_recovery.initial_seconds} seconds, increasing
                    up to {saved.gateway_recovery.maximum_seconds} seconds. One
                    recovery request checks the service before normal processing
                    continues. Manual pauses, disabled AI and spending limits
                    still hold work.
                  </p>
                )}
              </CardContent>
            </Card>
            <p className="settings-help">
              Manual only keeps the reviewed task buttons available. Off blocks
              the operation. AI also needs its own permission in Matching & AI.
            </p>
          </TabsContent>
          <TabsContent value="schedule" className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Import schedule</CardTitle>
                <CardDescription>
                  One shared schedule in Europe/Skopje. New schedules begin at
                  their next future occurrence.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel id="schedule-preset">Frequency</FieldLabel>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      value={preset}
                      onValueChange={(value) => {
                        if (!value) return;
                        setPreset(value);
                        if (value === "daily") set("cron", "0 12 * * *");
                        if (value === "weekly") set("cron", "0 12 * * 1");
                      }}
                      aria-labelledby="schedule-preset"
                      className="flex-wrap justify-start"
                    >
                      <ToggleGroupItem value="daily">
                        Daily at 12:00
                      </ToggleGroupItem>
                      <ToggleGroupItem value="weekly">
                        Monday at 12:00
                      </ToggleGroupItem>
                      <ToggleGroupItem value="custom">Custom</ToggleGroupItem>
                    </ToggleGroup>
                  </Field>
                  {(preset === "custom" || cronError) && (
                    <Field data-invalid={!!cronError}>
                      <FieldLabel htmlFor="setting-cron">
                        Cron expression
                      </FieldLabel>
                      <Input
                        id="setting-cron"
                        required
                        aria-invalid={!!cronError}
                        value={draft.cron}
                        onChange={(e) => {
                          set("cron", e.target.value);
                          setPreset("custom");
                        }}
                      />
                      <FieldDescription>
                        {cronError ||
                          "Five fields: minute, hour, day of month, month, day of week."}
                      </FieldDescription>
                    </Field>
                  )}
                  <FieldSet>
                    <FieldLegend>Stores to import</FieldLegend>
                    <FieldGroup className="grid gap-3 sm:grid-cols-3">
                      {saved.stores.map((store) => (
                        <Field key={store.slug} orientation="horizontal">
                          <Checkbox
                            id={`schedule-${store.slug}`}
                            disabled={!store.enabled}
                            checked={draft.scheduled_stores.includes(
                              store.slug as never,
                            )}
                            onCheckedChange={(checked) =>
                              set(
                                "scheduled_stores",
                                checked
                                  ? [
                                      ...draft.scheduled_stores,
                                      store.slug as never,
                                    ]
                                  : draft.scheduled_stores.filter(
                                      (id) => id !== store.slug,
                                    ),
                              )
                            }
                          />
                          <FieldLabel htmlFor={`schedule-${store.slug}`}>
                            {store.name}
                          </FieldLabel>
                        </Field>
                      ))}
                    </FieldGroup>
                  </FieldSet>
                  {toggle(
                    "catch_up",
                    "Catch up after downtime",
                    "Authorize at most one missed import per selected store.",
                  )}
                </FieldGroup>
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle>Next scheduled times</CardTitle>
                <CardDescription>
                  {draft.imports === "automatic" &&
                  draft.scheduled_stores.length
                    ? "Schedule active when these settings are saved."
                    : "Schedule inactive: choose Automatic for imports and select stores."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="schedule-occurrences">
                  {!cronError &&
                    nextRuns.map((date) => (
                      <li key={date}>
                        <CalendarClock />
                        <span>
                          {new Date(date).toLocaleString("en-GB", {
                            timeZone: "Europe/Skopje",
                          })}
                        </span>
                      </li>
                    ))}
                </ol>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="matching" className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>AI permissions</CardTitle>
                <CardDescription>
                  Permission doesn’t start any work. Each manual AI task still
                  needs to be reviewed.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  {toggle(
                    "ai_enabled",
                    "Allow AI calls",
                    "Let authorized categorization and matching tasks use the Gateway.",
                  )}
                  {!saved.key_ready && (
                    <FieldDescription>
                      Configure the Gateway key on the server before enabling
                      AI.
                    </FieldDescription>
                  )}
                  {toggle(
                    "clarification_enabled",
                    "Allow Qwen clarification",
                    "Interpret difficult supplied text once. Requires AI permission.",
                  )}
                </FieldGroup>
                <Accordion type="single" collapsible className="mt-4">
                  <AccordionItem value="models">
                    <AccordionTrigger>Models and connection</AccordionTrigger>
                    <AccordionContent>
                      <dl className="detail-fields">
                        <div>
                          <dt>Decision model</dt>
                          <dd>{saved.models.decision}</dd>
                        </div>
                        <div>
                          <dt>Clarification</dt>
                          <dd>{saved.models.clarification}</dd>
                        </div>
                        <div>
                          <dt>Gateway key</dt>
                          <dd>
                            {saved.key_ready ? "Ready" : "Not configured"}
                          </dd>
                        </div>
                      </dl>
                      <p className="settings-help">
                        Model names, keys and prompt files are managed in
                        deployment configuration.
                      </p>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Matching after imports</CardTitle>
                <CardDescription>
                  Turn off to import prices without starting matching. Your
                  category choices are kept.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field orientation="horizontal">
                    <Switch
                      id="setting-automatic-matching"
                      checked={draft.matching === "automatic"}
                      onCheckedChange={(enabled) =>
                        set("matching", enabled ? "automatic" : "manual")
                      }
                    />
                    <div>
                      <FieldLabel htmlFor="setting-automatic-matching">
                        Match automatically after imports
                      </FieldLabel>
                      <FieldDescription>
                        Off selects Manual only. Manual matching stays
                        available.
                      </FieldDescription>
                    </div>
                  </Field>
                </FieldGroup>
                <Accordion type="single" collapsible className="mt-4">
                  <AccordionItem value="categories">
                    <AccordionTrigger>
                      AI comparison categories · {draft.ai_categories.length}{" "}
                      selected
                    </AccordionTrigger>
                    <AccordionContent>
                      <CategoryChoices
                        id="automatic"
                        categories={saved.categories}
                        selected={draft.ai_categories}
                        disabled={draft.matching !== "automatic"}
                        description={
                          draft.matching === "automatic"
                            ? "AI compares these categories when permission is on. Code-based matching is available in every category."
                            : "Automatic matching is off. Your saved category choices are kept. Manual AI tasks choose their own categories."
                        }
                        onChange={(values) =>
                          set(
                            "ai_categories",
                            values as OperationalPolicy["ai_categories"],
                          )
                        }
                      />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="spending">
            <Card>
              <CardHeader>
                <CardTitle>Spending allowances</CardTitle>
                <CardDescription>
                  Every AI task must fit both its own allowance and the shared
                  allowance. Changing limits doesn’t reset spending.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="settings-budget-summary">
                  <div>
                    <dt>Initial allowance remaining</dt>
                    <dd>
                      {money(
                        Math.max(
                          0,
                          draft.initial_budget_usd -
                            Number(saved.spending.initial_usd),
                        ),
                      )}
                    </dd>
                    <p>
                      {money(Number(saved.spending.initial_usd))} already used
                    </p>
                  </div>
                  <div>
                    <dt>This month remaining</dt>
                    <dd>
                      {money(
                        Math.max(
                          0,
                          draft.monthly_budget_usd -
                            Number(saved.spending.monthly_usd),
                        ),
                      )}
                    </dd>
                    <p>
                      {money(Number(saved.spending.monthly_usd))} already used ·
                      Europe/Skopje
                    </p>
                  </div>
                </dl>
                <FieldGroup className="grid gap-4 sm:grid-cols-2">
                  {numeric("initial_budget_usd", "Initial allowance (USD)", {
                    step: "0.01",
                  })}
                  {numeric("monthly_budget_usd", "Monthly allowance (USD)", {
                    step: "0.01",
                  })}
                  {numeric("task_budget_usd", "Maximum per task (USD)", {
                    step: "0.01",
                  })}
                  {numeric("task_request_limit", "Maximum requests per task", {
                    min: 1,
                    max: 100000,
                  })}
                </FieldGroup>
              </CardContent>
            </Card>
            <p className="settings-help">
              A smaller allowance takes effect at the next safe checkpoint.
              Increasing it cannot expand an already reviewed task.
            </p>
          </TabsContent>
          <TabsContent value="brands">
            <BrandsManager onUnauthorized={onUnauthorized} />
          </TabsContent>
          <TabsContent value="advanced" className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Worker limits</CardTitle>
                <CardDescription>
                  Downloads can overlap while complete catalogs are saved one at
                  a time. Matching uses one worker.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup className="grid gap-4 sm:grid-cols-2">
                  {numeric(
                    "default_product_limit",
                    "Default products per task",
                    { min: 1, max: 100000 },
                  )}
                  {numeric("batch_size", "Products per worker batch", {
                    min: 1,
                    max: 50,
                  })}
                  {numeric("parallel_imports", "Parallel catalog downloads", {
                    min: 1,
                    max: saved.worker_limits.max_downloads,
                  })}
                  {numeric("per_store_downloads", "Downloads from each store", {
                    min: 1,
                    max: saved.worker_limits.max_downloads,
                  })}
                  {numeric(
                    "counterpart_limit",
                    "Extra counterpart interpretations per task",
                    { min: 0, max: 100000 },
                  )}
                  {numeric(
                    "counterparts_per_product",
                    "Counterparts interpreted per selected product",
                    { min: 0, max: 20 },
                  )}
                  {numeric("candidate_limit", "Candidate groups per product", {
                    min: 1,
                    max: 20,
                  })}
                  {numeric(
                    "candidate_batch_size",
                    "Candidates per decision request",
                    { min: 1, max: 5 },
                  )}
                </FieldGroup>
                <p className="settings-help">
                  Up to {saved.worker_limits.ready_catalogs} complete downloads
                  may wait for the database. Final catalog saves:{" "}
                  {saved.worker_limits.parallel_publications} at a time. New
                  tasks use these limits; resuming an import asks you to review
                  them again.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Decision thresholds</CardTitle>
                <CardDescription>
                  Probabilities are checked alongside supported product facts.
                  Product-safety rules always apply.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup className="grid gap-4 sm:grid-cols-2">
                  {numeric("category_threshold", "Category probability (%)", {
                    percent: true,
                    max: 100,
                  })}
                  {numeric("match_threshold", "Same-product probability (%)", {
                    percent: true,
                    max: 100,
                  })}
                </FieldGroup>
              </CardContent>
            </Card>
          </TabsContent>
        </WorkspaceSections>
      </fieldset>
    </form>
  );
}
