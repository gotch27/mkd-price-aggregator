"use client";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import type {
  TaskCommand,
  TaskKind,
  TaskSettingsView,
} from "@/nextsignal/domain/task-settings";
import type { TaskRequest } from "./types";
import { storeName, text } from "./types";
import { taskLabels, operation } from "./task-labels";
import { taskApi } from "./task-api";
import { useTaskCatalogs } from "./use-task-catalogs";
import { CategoryChoices } from "./task-settings-form";
import { TaskPicker, taskChoices } from "./task-picker";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldGroup,
} from "@/components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
export function RunForm({
  view,
  pageSize,
  onReview,
  onUnauthorized,
}: {
  view: TaskSettingsView;
  pageSize: number;
  onReview: (task: TaskRequest) => void;
  onUnauthorized: () => void;
}) {
  const [kind, setKind] = useState<TaskKind>("discover"),
    [scope, setScope] = useState("store"),
    [store, setStore] = useState(""),
    [source, setSource] = useState(""),
    [limit, setLimit] = useState(view.policy.default_product_limit),
    [all, setAll] = useState(false),
    [ai, setAi] = useState(false),
    [categories, setCategories] = useState<string[]>([]),
    [cost, setCost] = useState(view.policy.task_budget_usd),
    [recheck, setRecheck] = useState(false);
  const [scopeCounts, setScopeCounts] = useState<{
    counts: { family: string; count: number }[];
    uncategorized: number;
  } | null>(null);
  const catalogs = useTaskCatalogs(
    scope === "catalog" ? store : "",
    pageSize,
    onUnauthorized,
  );
  const categoryCountsKey = view.categories
    .map((c) => `${c.id}:${c.count}`)
    .join("|");
  useEffect(() => {
    setScopeCounts(null);
    if (kind !== "match" || !ai) return;
    const abort = new AbortController();
    void taskApi<{
      counts: { family: string; count: number }[];
      uncategorized: number;
    }>(
      `/api/tasks/categories?retailer=${encodeURIComponent(scope === "all" ? "" : store)}&source_id=${scope === "catalog" ? source : ""}`,
      onUnauthorized,
      { signal: abort.signal },
    )
      .then((v) => {
        if (!abort.signal.aborted) setScopeCounts(v);
      })
      .catch(() => {
        /* The settings alert/poll remains the authoritative health signal. */
      });
    return () => abort.abort();
  }, [
    kind,
    ai,
    scope,
    store,
    source,
    view.revision,
    categoryCountsKey,
    onUnauthorized,
  ]);
  const availableCategories = view.categories.map((c) => ({
    ...c,
    count: scopeCounts?.counts.find((row) => row.family === c.id)?.count ?? 0,
  }));
  const products = ["categorize", "llm_review", "match"].includes(kind),
    usesAi =
      ["categorize", "llm_review"].includes(kind) || (kind === "match" && ai),
    retailers =
      scope === "all"
        ? view.stores.filter((s) => s.enabled).map((s) => s.slug)
        : store
          ? [store]
          : [];
  const disabled =
    view.policy.paused ||
    view.policy[operation(kind)] === "off" ||
    !retailers.length ||
    (scope === "catalog" && !source) ||
    (usesAi &&
      (!view.policy.ai_enabled ||
        !view.key_ready ||
        cost < 0 ||
        cost > view.policy.task_budget_usd ||
        (kind === "match" && !categories.length))) ||
    (products &&
      !all &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000));
  function review(event: React.FormEvent) {
    event.preventDefault();
    if (disabled) return;
    const body: TaskCommand = {
      revision: view.revision,
      kind,
      retailers: retailers as TaskCommand["retailers"],
      source_id: scope === "catalog" ? source : null,
      product_limit: products && !all ? limit : null,
      use_ai: usesAi,
      categories:
        kind === "match" && usesAi
          ? (categories as TaskCommand["categories"])
          : [],
      max_cost_usd: usesAi ? cost : 0,
      recheck: kind === "llm_review" ? false : recheck,
      idempotency_key: crypto.randomUUID(),
    };
    const action =
      kind === "discover"
        ? "Discover catalogs without downloading their prices."
        : kind === "import"
          ? "Retrieve, validate and publish complete catalogs. No product limit truncates an import."
          : kind === "llm_review"
            ? `Review uncertain categories using ${view.models.clarification}. Only products already needing review are selected; unclear products remain in Review. Saved human, agent and LLM choices are protected.`
            : kind === "categorize"
              ? "Categorize only the selected products. This task does not compare or connect products."
              : "Check products for matches across different stores. Existing saved connections remain.";
    const automaticSteps =
      kind === "import"
        ? [
            view.policy.categorization === "automatic" && view.policy.ai_enabled
              ? "automatic categorization"
              : "",
            view.policy.matching === "automatic"
              ? "automatic code matching"
              : "",
            view.policy.matching === "automatic" &&
            view.policy.ai_enabled &&
            view.policy.ai_categories.length
              ? "AI comparisons in the saved automatic categories"
              : "",
          ].filter(Boolean)
        : [];
    const importEffect = automaticSteps.length
      ? `The import itself uses no AI. New or changed products can also start ${automaticSteps.join(", ")}. Each automatic AI task has a $${view.policy.task_budget_usd.toFixed(2)} allowance, constrained by the shared $${view.policy.initial_budget_usd} initial and $${view.policy.monthly_budget_usd} monthly limits.`
      : "The import uses no AI. Categorization and matching wait for separately reviewed tasks.";
    onReview({
      endpoint: "/api/tasks",
      body,
      title: `${taskLabels[kind]}?`,
      scope: `${retailers.map(storeName).join(", ")}${scope === "catalog" ? ` · ${text(catalogs.rows.find((c) => c.id === source)?.name)}` : ""}`,
      effect: `${action} ${products ? `Limit: ${all ? "all pending products (explicit selection)" : `${limit} unique store products`}.` : ""} ${usesAi ? `AI allowed up to $${cost.toFixed(2)} total and the shared initial/monthly allowances. ${kind === "match" ? `Use saved categories only: ${categories.join(", ")}. Uncategorized products stay waiting.` : ""}` : kind === "import" ? importEffect : "Code only; zero AI calls."} ${products ? (recheck ? "Include already checked products." : "Process waiting products only.") : ""} Reviewed settings revision ${view.revision}.`,
      submitLabel: "Start task",
      successMessage:
        "Task accepted. Its scope and allowance are saved. Follow progress in Run Tasks.",
    });
  }
  return (
    <TaskPicker
      value={kind}
      onChange={(next) => {
        if (next === kind) return;
        setKind(next);
        setAi(false);
        setAll(false);
        setRecheck(false);
        setCategories([]);
        setLimit(view.policy.default_product_limit);
        setCost(view.policy.task_budget_usd);
        if (next === "discover" && scope === "catalog") setScope("store");
      }}
    >
      <form
        onSubmit={review}
        id="task-options"
        aria-labelledby="task-options-title"
      >
        <Card>
          <CardHeader>
            <CardTitle id="task-options-title">{taskLabels[kind]}</CardTitle>
            <CardDescription>
              {taskChoices.find((choice) => choice.id === kind)?.detail}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel id="task-scope">Scope</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={scope}
                  onValueChange={(v) => {
                    if (v) {
                      setScope(v);
                      setSource("");
                    }
                  }}
                  aria-labelledby="task-scope"
                  className="flex-wrap justify-start"
                >
                  <ToggleGroupItem value="store">One store</ToggleGroupItem>
                  {kind !== "discover" && (
                    <ToggleGroupItem value="catalog">
                      One catalog
                    </ToggleGroupItem>
                  )}
                  <ToggleGroupItem value="all">
                    All enabled stores
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>
              {scope !== "all" && (
                <Field>
                  <FieldLabel htmlFor="task-store">Store</FieldLabel>
                  <Select
                    value={store}
                    onValueChange={(v) => {
                      setStore(v);
                      setSource("");
                    }}
                  >
                    <SelectTrigger id="task-store" className="w-full">
                      <SelectValue placeholder="Choose a store" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {view.stores
                          .filter((s) => s.enabled)
                          .map((s) => (
                            <SelectItem key={s.slug} value={s.slug}>
                              {s.name}
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {scope === "catalog" && (
                <Field>
                  <FieldLabel htmlFor="task-source">Catalog</FieldLabel>
                  <Select
                    value={source}
                    onValueChange={setSource}
                    disabled={!store || catalogs.loading}
                  >
                    <SelectTrigger id="task-source" className="w-full">
                      <SelectValue
                        placeholder={
                          catalogs.loading
                            ? "Loading catalogs…"
                            : "Choose a catalog"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {catalogs.rows.map((row) => (
                          <SelectItem key={text(row.id)} value={text(row.id)}>
                            {text(row.name)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {catalogs.error && (
                    <FieldDescription>{catalogs.error}</FieldDescription>
                  )}
                </Field>
              )}
              {kind === "llm_review" && (
                <Alert>
                  <AlertTitle>
                    Review with {view.models.clarification}
                  </AlertTitle>
                  <AlertDescription>
                    Only available products needing review after the decision
                    model are selected. Saved human, agent and LLM choices are
                    protected. Clear categories save as LLM; uncertain products
                    stay in Review. Each product uses one request, subject to
                    the task and shared spending limits.
                  </AlertDescription>
                </Alert>
              )}
              {products && (
                <>
                  <Field>
                    <FieldLabel htmlFor="task-limit">
                      Unique store products
                    </FieldLabel>
                    <Input
                      id="task-limit"
                      type="number"
                      min={1}
                      max={100000}
                      required
                      disabled={all}
                      value={limit}
                      onChange={(e) => setLimit(e.target.valueAsNumber)}
                    />
                    <FieldDescription>
                      Only products reported available in this scope are
                      processed. Unavailable and unknown availability are
                      skipped. Branch copies do not count as new products.
                    </FieldDescription>
                  </Field>
                  <Field orientation="horizontal">
                    <Checkbox
                      id="task-all"
                      checked={all}
                      onCheckedChange={(v) => setAll(v === true)}
                    />
                    <FieldLabel htmlFor="task-all">
                      All pending products in this scope
                    </FieldLabel>
                  </Field>
                  {kind !== "llm_review" && (
                    <Field orientation="horizontal">
                      <Checkbox
                        id="task-recheck"
                        checked={recheck}
                        onCheckedChange={(v) => setRecheck(v === true)}
                      />
                      <div>
                        <FieldLabel htmlFor="task-recheck">
                          Include previously checked products
                        </FieldLabel>
                        <FieldDescription>
                          Use this when reviewing new prompts or matching rules.
                        </FieldDescription>
                      </div>
                    </Field>
                  )}
                </>
              )}
              {kind === "match" && (
                <Field>
                  <FieldLabel id="task-ai-label">Matching method</FieldLabel>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={ai ? "ai" : "code"}
                    onValueChange={(v) => {
                      if (v) setAi(v === "ai");
                    }}
                    aria-labelledby="task-ai-label"
                    className="justify-start"
                  >
                    <ToggleGroupItem value="code">Code only</ToggleGroupItem>
                    <ToggleGroupItem
                      value="ai"
                      disabled={!view.policy.ai_enabled}
                    >
                      AI assisted
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <FieldDescription>
                    AI matching uses saved categories only. Products without a
                    category stay waiting for the categorization task.
                  </FieldDescription>
                </Field>
              )}
              {kind === "match" && ai && (
                <CategoryChoices
                  id="manual"
                  categories={availableCategories}
                  selected={categories}
                  onChange={setCategories}
                  description={`Saved category counts in the selected scope. ${scopeCounts?.uncategorized ?? "…"} products are waiting for categorization. These will not be added to this matching task.`}
                />
              )}
              {usesAi && (
                <>
                  <Field>
                    <FieldLabel htmlFor="task-cost">
                      Total task allowance (USD)
                    </FieldLabel>
                    <Input
                      id="task-cost"
                      type="number"
                      min={0}
                      step="0.01"
                      max={view.policy.task_budget_usd}
                      value={cost}
                      required
                      onChange={(e) => setCost(e.target.valueAsNumber)}
                    />
                    <FieldDescription>
                      Also constrained by the shared $
                      {view.policy.initial_budget_usd} initial and $
                      {view.policy.monthly_budget_usd} monthly allowances, and{" "}
                      {view.policy.task_request_limit} requests per task.
                      Follow-up batches share this same limit.
                    </FieldDescription>
                  </Field>
                  {!view.policy.ai_enabled && (
                    <Alert>
                      <AlertTitle>AI permission is off</AlertTitle>
                      <AlertDescription>
                        Enable AI in Settings before reviewing this task.
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              )}
              {view.policy[operation(kind)] === "off" && (
                <Alert>
                  <AlertTitle>This operation is off</AlertTitle>
                  <AlertDescription>
                    Choose Manual only or Automatic in settings first.
                  </AlertDescription>
                </Alert>
              )}
            </FieldGroup>
          </CardContent>
          <CardFooter className="justify-end">
            <Button type="submit" disabled={disabled}>
              Review task
              <ArrowRight data-icon="inline-end" />
            </Button>
          </CardFooter>
        </Card>
      </form>
    </TaskPicker>
  );
}
