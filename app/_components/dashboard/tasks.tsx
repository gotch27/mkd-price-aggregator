import { useState } from "react";
import { ArrowRight, Link2, RefreshCw, RotateCcw } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
} from "@/components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { useTaskCatalogs } from "@/app/_components/dashboard/use-task-catalogs";
import {
  number,
  text,
  storeName,
  kindName,
  type Row,
  type Summary,
  type TaskSettings,
  type TaskRequest,
} from "@/app/_components/dashboard/types";

function matchingDescription(settings: TaskSettings) {
  return [
    `Local matching is ${settings.localEnabled ? "on" : "off"}.`,
    settings.aiEnabled
      ? "AI matching is on and may incur provider charges."
      : "AI matching is off.",
  ].join(" ");
}

function retryTask(row: Row, settings: TaskSettings): TaskRequest {
  return {
    endpoint: "/api/retry",
    body: { id: text(row.id) },
    title: `Retry: ${kindName(row.kind)}`,
    scope: [
      row.retailer ? storeName(row.retailer) : "All stores",
      row.source_name,
    ]
      .filter(Boolean)
      .join(" · "),
    effect:
      (row.kind === "discover"
        ? "Find this store’s catalogs again and queue their price imports."
        : row.kind === "catalog"
          ? "Request another price import for this catalog."
          : "Re-run this matching task using its original catalog scope. Existing product connections stay in place.") +
      (row.kind === "match" || settings.matchingEnabled
        ? ` ${matchingDescription(settings)}`
        : ""),
    submitLabel: "Start retry",
    successMessage: "Retry accepted. Follow its progress in Data updates.",
  };
}

export function Tasks({
  settings,
  summary,
  pageSize,
  retry,
  onReview,
  onDismissRetry,
  onUpdates,
  onUnauthorized,
}: {
  settings: TaskSettings;
  summary: Summary | null;
  pageSize: number;
  retry: Row | null;
  onReview: (task: TaskRequest) => void;
  onDismissRetry: () => void;
  onUpdates: () => void;
  onUnauthorized: () => void;
}) {
  const [importStore, setImportStore] = useState("");
  const [matchScope, setMatchScope] = useState("");
  const [matchStore, setMatchStore] = useState("");
  const [matchSource, setMatchSource] = useState("");
  const catalogs = useTaskCatalogs(
    matchScope === "catalog" ? matchStore : "",
    pageSize,
    onUnauthorized,
  );
  const selectedCatalog = catalogs.rows.find((row) => row.id === matchSource);
  const enabledStores = settings.stores.filter((store) => store.enabled);
  const importCatalogs = summary?.retailers
    .filter((store) =>
      importStore === "all"
        ? enabledStores.some((enabled) => enabled.slug === store.slug)
        : store.slug === importStore,
    )
    .reduce((total, store) => total + Number(store.sources), 0);
  const matchingMethods = matchingDescription(settings);
  const retryDisabled =
    !!retry &&
    ((retry.kind === "match" && !settings.matchingEnabled) ||
      (!!retry.retailer &&
        !enabledStores.some((store) => store.slug === retry.retailer)));
  return (
    <div className="flex flex-col gap-4">
      {retry && (
        <Card>
          <CardHeader>
            <CardTitle>Retry an update</CardTitle>
            <CardDescription>
              {kindName(retry.kind)} · {retryTask(retry, settings).scope}
            </CardDescription>
            <CardAction>
              <RotateCcw className="size-4 text-muted-foreground" />
            </CardAction>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {text(retry.error, "This update did not complete.")}
            </p>
            {retryDisabled && (
              <p className="text-sm text-muted-foreground">
                This task is currently disabled.
              </p>
            )}
          </CardContent>
          <CardFooter className="justify-between gap-3">
            <Button variant="ghost" onClick={onDismissRetry}>
              Dismiss retry
            </Button>
            <Button
              variant="outline"
              disabled={retryDisabled}
              onClick={() => onReview(retryTask(retry, settings))}
            >
              Review retry
              <ArrowRight data-icon="inline-end" />
            </Button>
          </CardFooter>
        </Card>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Import store prices</CardTitle>
            <CardDescription>
              Find store catalogs, download their published prices, and update
              the database.
            </CardDescription>
            <CardAction>
              <RefreshCw className="size-4 text-muted-foreground" />
            </CardAction>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="task-import-store">
                  Store to import
                </FieldLabel>
                <Select
                  value={importStore}
                  onValueChange={setImportStore}
                  disabled={!enabledStores.length}
                >
                  <SelectTrigger id="task-import-store" className="w-full">
                    <SelectValue placeholder="Choose a store or all stores" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">
                        All enabled stores ({enabledStores.length})
                      </SelectItem>
                      {enabledStores.map((store) => (
                        <SelectItem key={store.slug} value={store.slug}>
                          {store.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {!enabledStores.length
                    ? "No stores are enabled for imports."
                    : importStore && importCatalogs !== undefined
                      ? `${number(importCatalogs)} known catalogs. Discovery may find more.`
                      : "An import contacts the selected store websites and processes their catalogs."}
                </FieldDescription>
              </Field>
              <p className="text-sm text-muted-foreground">
                {settings.matchingEnabled
                  ? "Price imports also queue product matching. "
                  : "Product matching is currently disabled. "}
                {settings.matchingEnabled && matchingMethods}
              </p>
            </FieldGroup>
          </CardContent>
          <CardFooter className="justify-end">
            <Button
              variant="outline"
              disabled={!importStore || !enabledStores.length}
              onClick={() =>
                onReview({
                  endpoint: "/api/ingestion",
                  body: {
                    retailer: importStore === "all" ? null : importStore,
                  },
                  title: "Start a price import?",
                  scope:
                    importStore === "all"
                      ? `All ${enabledStores.length} enabled stores`
                      : storeName(importStore),
                  effect: `Discover catalogs and queue their price imports.${settings.matchingEnabled ? ` Imported products also enter matching. ${matchingMethods}` : ""}`,
                  submitLabel: "Start import",
                  successMessage:
                    "Import accepted. Follow catalog discovery, price imports, and any matching tasks in Data updates.",
                })
              }
            >
              Review import
              <ArrowRight data-icon="inline-end" />
            </Button>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Match products</CardTitle>
            <CardDescription>
              Re-check unresolved products against products across stores.
              Existing connections stay in place.
            </CardDescription>
            <CardAction>
              <Link2 className="size-4 text-muted-foreground" />
            </CardAction>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="task-match-scope">
                  Products to re-check
                </FieldLabel>
                <Select
                  value={matchScope}
                  onValueChange={(value) => {
                    setMatchScope(value);
                    setMatchStore("");
                    setMatchSource("");
                  }}
                  disabled={!settings.matchingEnabled}
                >
                  <SelectTrigger id="task-match-scope" className="w-full">
                    <SelectValue placeholder="Choose a matching scope" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">All catalogs</SelectItem>
                      <SelectItem value="catalog">One catalog</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {settings.matchingEnabled
                    ? "Choosing all catalogs re-opens unresolved products throughout the database and can involve substantial work."
                    : "Product matching is currently disabled."}
                </FieldDescription>
              </Field>
              {matchScope === "catalog" && (
                <>
                  <Field>
                    <FieldLabel htmlFor="task-match-store">
                      Catalog store
                    </FieldLabel>
                    <Select
                      value={matchStore}
                      onValueChange={(value) => {
                        setMatchStore(value);
                        setMatchSource("");
                      }}
                    >
                      <SelectTrigger id="task-match-store" className="w-full">
                        <SelectValue placeholder="Choose a store" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {settings.stores.map((store) => (
                            <SelectItem key={store.slug} value={store.slug}>
                              {store.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="task-match-catalog">
                      Catalog to re-check
                    </FieldLabel>
                    <Select
                      value={matchSource}
                      onValueChange={setMatchSource}
                      disabled={
                        !matchStore || catalogs.loading || !catalogs.rows.length
                      }
                    >
                      <SelectTrigger id="task-match-catalog" className="w-full">
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
                          {catalogs.rows.map((catalog) => (
                            <SelectItem
                              key={text(catalog.id)}
                              value={text(catalog.id)}
                            >
                              {text(catalog.name)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {matchStore &&
                      !catalogs.loading &&
                      !catalogs.error &&
                      !catalogs.rows.length && (
                        <FieldDescription>
                          No active catalogs for this store.
                        </FieldDescription>
                      )}
                  </Field>
                  {catalogs.error && (
                    <Alert variant="destructive">
                      <AlertTitle>Unable to load catalogs</AlertTitle>
                      <AlertDescription>
                        {catalogs.error}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={catalogs.refresh}
                        >
                          Reload catalogs
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              )}
              <p className="text-sm text-muted-foreground">{matchingMethods}</p>
            </FieldGroup>
          </CardContent>
          <CardFooter className="justify-end">
            <Button
              variant="outline"
              disabled={
                !settings.matchingEnabled ||
                !matchScope ||
                (matchScope === "catalog" && !selectedCatalog)
              }
              onClick={() =>
                onReview({
                  endpoint: "/api/matching",
                  body: {
                    source_id:
                      matchScope === "catalog"
                        ? text(selectedCatalog?.id)
                        : null,
                  },
                  title: "Start product matching?",
                  scope:
                    matchScope === "all"
                      ? "All catalogs across all stores"
                      : `${storeName(matchStore)} · ${text(selectedCatalog?.name)}`,
                  effect: `Re-open unresolved products in this scope and run matching against products across stores. Existing connections stay in place. ${matchingMethods}`,
                  submitLabel: "Start matching",
                  successMessage:
                    "Matching accepted. Existing connections stay in place. Follow progress in Data updates.",
                })
              }
            >
              Review matching
              <ArrowRight data-icon="inline-end" />
            </Button>
          </CardFooter>
        </Card>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Accepted tasks continue in the background. Track progress and results
          in Data updates.
        </p>
        <Button variant="ghost" onClick={onUpdates}>
          View data updates
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}
