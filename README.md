# MKD Catalog

Private supermarket catalog imports and cross-store product matching, built with Next.js and **Nextsignal 0.1.0-alpha.2**.

See [the data model and SQL examples](docs/data-model.md) when building the next product on this database.
See [the architecture and code map](docs/architecture.md) for imports and module responsibilities.
See [the matching workflow and review guide](docs/matching.md) for the new Gateway integration, safety checks, budgets, and evaluation commands.

The latest [category-first matching flow](docs/category-first-matching.md) categorizes unique store products once, permits code-based matches in every category, and limits AI comparisons to selected labels. Review the [external prompt files](prompts/README.md) before activation. `matching.ai_categories` is intentionally empty; automatic matching and Gateway access remain disabled.

Store product cards now support [manual detail corrections and edit history](docs/product-detail-editing.md). Corrections survive repeat imports, preserve the original store data, and are logged through the existing adapters. Saving details makes no AI request.

## Start

Requires Docker with Compose and Node 24 for local commands.

```sh
npm ci
npm run setup
# Review .env.local: generated administrator password, database credentials and ports.
docker compose --env-file .env.local up -d --build
# Explicit initial import; the configured weekly schedule handles subsequent runs.
npm run ingest -- --all
```

Open the web address determined by `WEB_PORT` in `.env.local` (the example uses http://localhost:3000). Username is configured under `auth.username`; the generated password is `NEXTSIGNAL_AUTH__PASSWORD` in `.env.local`. Setup refuses to overwrite existing configuration. This checkout has already been initialized; reuse its existing `.env.local`.

For this initialized checkout, start the dashboard for review with background processing stopped:

```sh
docker compose --env-file .env.local stop worker
docker compose --env-file .env.local up -d --build postgres migrate web
```

Use `--build` after source or JSON configuration changes. Plain `up -d` can reuse old images; an older migration image may reject newly added settings with `Invalid NextSignal configuration`. Rebuild the image rather than removing the settings. These commands preserve the existing database volume.

## Configuration is mandatory

`config/default.json` is the explicit, committed configuration, despite the framework's conventional filename. **There are no application-level configuration fallbacks or schema defaults.** Root environment variables override it through Nextsignal's `NEXTSIGNAL_` provider. Missing or unknown values fail startup with the relevant configuration path. The web server, workers, scripts, migrations and tests use the same validation.

```dotenv
NEXTSIGNAL_SCHEDULER__CRON=0 12 * * 1
NEXTSIGNAL_APP__TIMEZONE=Europe/Skopje
NEXTSIGNAL_SOURCES__SPAR__CRON=0 12 * * 1,4
NEXTSIGNAL_MATCHING__AUTOMATIC_ENABLED=false
NEXTSIGNAL_MATCHING__GATEWAY__ENABLED=false
NEXTSIGNAL_MATCHING__GATEWAY__API_KEY=your-vercel-ai-gateway-key
NEXTSIGNAL_MATCHING__GATEWAY__INITIAL_BUDGET_USD=25
NEXTSIGNAL_MATCHING__GATEWAY__MONTHLY_BUDGET_USD=2
```

An explicit source cron of `null` selects the configured global cron. The browser origin must be explicitly included in `auth.allowed_origins`, including its port. Apply environment changes with `docker compose --env-file .env.local up -d --force-recreate web worker`. A plain container restart keeps its previous environment. JSON configuration changes require rebuilding both runtimes. A changed schedule resets its persisted next occurrence.

**Automatic matching and Gateway calls are disabled pending implementation review and a jointly reviewed evaluation.** Supplying a key does not enable either switch. Do not start the full matching campaign until approved. An initial campaign shares one $25 allowance across all batches; subsequent updates share $2 per calendar month in Europe/Skopje. Interrupted requests retain their estimated reservation until billing can be reconciled. Usage is an application ledger, not an invoice. The former `matching.ai` configuration is accepted only for compatibility with existing environments; the retired OpenAI client is no longer used and its flag cannot activate this workflow.

Other explicit settings cover queue concurrency/retries/heartbeats, host request intervals, byte/time/page limits, source page sizes, identity policy, catalog reduction confirmation, logging, dashboard paging, matching rules, models, prompt versions, candidate scoring, and limits. `config/build.json` contains non-runtime validation values for image builds; runtime secrets remain required separately.

For internet-facing deployment, explicitly enable `auth.secure_cookie`, terminate HTTPS at your reverse proxy, and configure its origin consistently. Compose binds the application and database ports to loopback. `APP_ENV_FILE` chooses the runtime environment file; keep it consistent with Compose's `--env-file` argument.

Request intervals are required per host under `http.host_intervals_ms`; discovered hosts without configuration fail visibly. The SPAR API advertises a 1,000-request rate limit, and its configured interval is 200ms (at most five requests/second). Stokomak and Žito use 500ms; the remaining hosts use 1,000ms. The shared Žur/Dim endpoint has one shared limiter across workers.

Schedules use five-field cron expressions. `scheduler.tick_cron` and `scheduler.tick_ms` explicitly configure the required one-minute framework bridge; retailer schedules are evaluated by those durable ticks. An existing discovery or catalog run blocks another scheduled ingestion for that retailer; after it finishes, the configured catch-up policy governs the missed occurrence. Matching does not block price refreshes.

## Data and processes

- `web`: Next.js dashboard and thin authenticated Nextsignal API routes.
- `worker`: Nextsignal background host; pg-boss queue and durable scheduler adapters use the owned PostgreSQL database.
- `migrate`: ordered, advisory-locked SQL migrations before startup.
- `postgres`: PostgreSQL 17 with persistent storage and `pg_trgm`.

Each retailer has its own `catalog.<retailer>.retrieve` business process. Discovery and catalog downloads share `catalog.download`; fully downloaded catalogs use `catalog.publish` for their final save. Reviewed tasks and live settings allow two downloads by default, including two branches from one chain, while a shared database lock allows one final save at a time. A bounded ready buffer prevents downloads from outrunning the database. `tasks.job` handles task orchestration and product work. Every queue's capacity is explicit in `queue.concurrency`, and the application pool is validated against its advisory-lock and transaction requirements. Source and run locks make repeated deliveries safe; older snapshots cannot replace newer publications. See [import reliability](docs/import-reliability.md) for recovery, settings, logs, and saved dashboard statistics.

Catalog pages and checkpoints are stored transactionally in staging. Occurrence counters are recovered from indexed staging rows, keeping checkpoints small even for large catalogs. A complete validated catalog atomically replaces offers for its source. Empty or substantially reduced catalogs require an identical independent confirming retrieval. A failed confirmation retains the existing publication. Changed snapshot timestamps or advertised counts, incompatible page sizes, and identity-policy changes create a fresh durable run instead of continuing a mixed checkpoint. This recovery is atomic and idempotent, preserves the last publication, and is bounded by the explicit `queue.retry_limit`; exhausting it leaves a visible failure. Snapshot restarts retain their ingestion budget family. Empty-catalog confirmations inherit the same restart count.

The database separates original branch `listings`, current branch/catalog `offers`, durable unique `store_products`, and shared `products`. Branch copies point to one store-product revision. Each meaningful descriptive change creates another revision; price-only changes preserve the connection and create no new matching work. Missing products lose current offers, while saved information, decisions, and connections remain available indefinitely. Returning unchanged products reuse their saved revision.

Original strings and source fields remain available. All prices are exact PostgreSQL numeric MKD values. Invalid prices may remain `null` with their raw text retained; the dashboard displays **Unknown**, never zero. Historical price series are not stored. Retailer article codes remain scoped to their chain and descriptive fingerprint; conflicting descriptions and ambiguous duplicates are flagged rather than guessed.

Matching searches other chains using indexed names, reviewed brands, amounts, barcodes, and exact signatures. It compares at most 20 candidate groups in batches of five independent same/different/insufficient questions. Several candidates can join together after checking every member of the resulting group. Qwen can clarify a source-supported missing fact once. Price, branch, and run identifiers do not enter reusable provider requests. Publication writes aliases and durable work in the same transaction; HTTP reads and browser refresh never launch matching. See [matching.md](docs/matching.md).

Each run pins its published source URL. Offers retain that URL, run ID, source update time and retrieval time, even when discovery subsequently advances to a new dated catalog. A failed replacement cannot change the provenance of the last successful offers.

## Source details and known limits

| Retailer        | Published format         | Operational detail                                                                                                                                                                                                                                     |
| --------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| KAM             | Branch API → PDF         | Poppler reconstructs wrapped product names and descriptions by table columns. Image-only or changed PDFs fail visibly.                                                                                                                                 |
| Ramstore        | Branch HTML tables       | Discovers the site's button destinations; imports complete tables.                                                                                                                                                                                     |
| Stokomak / Žito | Branch HTML pagination   | **Page size is explicitly 100.** The sites accept 500 but return only 100 while advancing by 500, which skips records. Unsupported sizes are rejected.                                                                                                 |
| SPAR            | Paginated JSON           | Validates advertised total against all staged rows. The API repeats some article codes with different prices, including in a single response. Preserve every occurrence and flag repeated identities as ambiguous; article codes remain source-scoped. |
| Vero            | Static branch HTML pages | Follows every next-page link. Repeated indistinguishable descriptions remain separate.                                                                                                                                                                 |
| Žur / Dim       | AJAX table fragments     | Configured to retrieve up to 20,000 rows per request. Smaller pages have unstable ordering and can duplicate/miss rows between requests. Native-code conflicts reject publication.                                                                     |
| Reptil          | Shared online catalog    | Published location metadata currently links branches to one webshop. Its complete public WooCommerce catalog is imported at retailer scope, **not as verified branch prices**. The published reuse notice is recorded.                                 |

A source counted as discovered is not necessarily imported or fresh. `npm run coverage` writes `.data/coverage.md` and `.data/coverage.json`, including all gaps, shared scopes, confirmed empty publications and the configured freshness limit. Stokomak and Žito render changing update labels on each page; their explicit `timestamp_policy` is `observed`, while stable snapshot timestamps use `snapshot`. Source timestamps remain as reported. External gaps cannot be reported as complete branch coverage. Prices reflect published observations, not a guarantee of checkout availability.

## Operations

```sh
npm run ingest -- spar
npm run coverage
npm run retry:failed
npm run run -- RUN_UUID         # execute a specific persisted run through its business process
npm run matching:evaluate       # small constructed controls, isolated DB, no paid calls
npm run matching:sample -- review-1  # read-only sample; review labels before evaluation
npm run probe -- spar ramstore  # live first-page diagnostics; updates captured fixtures

docker compose --env-file .env.local logs -f worker
docker compose --env-file .env.local restart worker
```

The shadcn/ui dashboard has five screens: Overview for statistics; Products for store → catalog → product browsing and universal product groups; Data updates for monitoring imports and matching jobs; Tasks for starting imports, matching and retries after choosing a scope and reviewing the work; and Logs for correlated events with severity colors. Browsing and monitoring never start background tasks directly. Product details show store listings, catalog prices and readable matching history. Only Logs exposes JSON. Filters and pagination survive reloads and browser navigation. It uses a single configured administrator with signed HttpOnly sessions. APIs are authenticated except health/login; mutation requests check their Origin.

PostgreSQL is configured with 1GB of shared memory in Compose; the container runtime's 64MB setting is insufficient for aggregate queries over the full branch catalog. Server memory, connection limits, WAL size, compression and checkpoint cadence are required `POSTGRES_` values in the environment templates. The initialized configuration uses 256MB shared buffers and an 8GB WAL limit to avoid continuous checkpoints during large imports. Review these explicit resource values for the deployment host.

Database logging is independent of business transactions. Failed log inserts spool to each runtime's persistent volume and are replayed idempotently. Secrets are redacted from nested data and errors. Operational and debug retention are explicit configuration values. Queue jobs use persisted retries and heartbeats; failed jobs and application runs remain inspectable.

## Verification

```sh
npm run check
npm test                # creates and uses the dedicated database in config/testing.json
npm run build
npm run smoke           # HTTP auth, dashboard views and validation against testing.web_url
npm run browser:smoke   # headless visual/browser check; install Chromium first
npm run backup:smoke    # snapshot dump, isolated restore, verify counts/references, remove test database
```

`npm test` never truncates the application database and explicitly disables live AI. It covers all nine parsers, money/encoding/identity, catalog replacement and provenance, locks/recovery, cron/DST/catch-up, configuration failure, sessions, log-spool replay, incremental matching, and mocked AI failures/budgets/cache. The replacement evaluation exercises actual retrieval, decisions, validation, and group formation in its own disposable database. Constructed controls are explicitly distinguished from manually reviewed real-store samples. Reports include correct/incorrect connections, unresolved cases, retrieval coverage, calls, and cost; a small test is not a general accuracy guarantee.

## Backup and restore

```sh
mkdir -p .data
# Database variables are resolved inside the container, not exposed in command arguments.
docker compose --env-file .env.local exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > .data/catalog.dump
# Restore into a separate empty database for verification, or an explicitly chosen replacement.
docker compose --env-file .env.local exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" catalog_restore'
docker compose --env-file .env.local exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d catalog_restore' < .data/catalog.dump
```

The database contains products, current offers, staging/checkpoints, jobs, matching cache/usage, and logs. Back up the log spool volumes as well if they contain entries not yet replayed. Docker volumes survive container recreation; deleting volumes destroys their data.

## Responsive browsing and laptop resource limits

Products shows one row per **retailer + source article key + identity**, with a
branch/catalog count and the observed price range. Details opens every current
branch offer for that identity, plus connected products. The raw branch listings
and offers remain authoritative; deduplicating the browser does not remove them.

`store_product_browser` reads canonical store products and compact per-source prices.
During migration, unmapped records remain visible through the legacy indexed
`catalog_browser`. The worker refreshes that fallback after an import wave.
Matching and new-product publication do not depend on that refresh. Every table API returns its
view, rows, exact total and page count. Matching evidence stores its source name
and retailer at decision time, so filtering does not join the entire listing table.

Unusable names such as SPAR's published `*` or `.` are retained. The explicitly
configured `dashboard.product_name_quality` controls the initial filter; the
screen lets you inspect usable names, unusable names, or all source records.
Original strings and provenance remain available in Details.

Dashboard requests are cancelled when their query changes. Responses belong to a
specific view/filter/page key and cannot overwrite another view. Search debounce,
refresh cadence, auto-refreshed views, and summary-cache lifetime are required
configuration. Products does not auto-poll in the committed configuration; hidden
browser tabs do not issue refresh requests, and periodic requests never overlap.

Compose requires explicit `*_MEMORY_LIMIT` and `*_CPUS` values for each service.
The initialized laptop profile caps PostgreSQL at 2 GB / 1.5 CPUs, web at 512 MB /
1 CPU, and worker at 768 MB / 1 CPU. The one-shot migration service is capped at
1 GB / 1 CPU. PostgreSQL uses 256 MB shared buffers, 4 MB work memory, and at most
64 connections; app pools and queue concurrency are reduced accordingly. All
consumer concurrency values are explicitly 1, and queue polling is 10 seconds.
These limits apply to running services; Docker image builds and the Docker VM
have their own resource settings.

Inspect current use with:

```sh
docker stats --no-stream
docker system df
```

Docker Desktop's VM memory ceiling is separate from actual resident memory and
service limits. Its Resource Saver stops the VM only when no containers are
running. To stop this project while keeping its database and logs:

```sh
docker compose --env-file .env.local stop
# Restart; configured catch-up handles missed scheduled work.
docker compose --env-file .env.local up -d --wait
```

Global Docker build caches may include other projects. Inspect them before doing
any global cleanup; never use volume pruning to make this application smaller.

## Matching activation

Start with a fresh database and review small manual tasks before enabling automation. Schema setup uses `npm run migrate`; successful imports create the store-product records used by categorization and matching. No separate preparation or backfill command is required. See [docs/matching.md](docs/matching.md) for the workflow and evaluation.

The new engine keeps conservative free exact-signature/barcode checks before Decider. Configured Macedonian spelling normalization, reviewed brand aliases, source quotes, and group-wide conflict checks also apply to AI proposals. Both `matching.automatic_enabled` and `matching.gateway.enabled` must be enabled deliberately for automatic paid work. Tasks provides contextual process-pending, pause, and resume controls without resetting completed products. Products → Details → Matching also provides a [manual interface](docs/manual-matching.md) for saved connections, remembered separations and deliberate undo. These actions make no AI calls; the automatic workflow has no approval queue.

The bounded [Glyph versus Qwen comparison](docs/glyph-vs-qwen-2026-10-23.md) is available with `npm run matching:compare-models -- --paid`. The first attempt was blocked by Vercel account eligibility, without a charge; it produced no model accuracy comparison.

## Gradual activation

Use **Tasks → Automation & settings** for saved operational controls. Fresh deployments use manual imports/categorization/matching, with AI off and no scheduled stores. The worker can remain running without releasing historical work. Review a small task in **Run tasks**, then enable automation when ready. See [Tasks and gradual activation](docs/task-controls.md) for permission, spending, schedule and restart behavior, and [Import reliability and recovery](docs/import-reliability.md) for fair scheduling, cooldowns, logs, and retrying unfinished catalogs.
