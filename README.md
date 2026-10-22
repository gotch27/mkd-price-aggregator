# MKD Catalog

Private supermarket catalog ingestion and product identity foundation, built with Next.js and **Nextsignal 0.1.0-alpha.2**.

See [the data model and SQL examples](docs/data-model.md) when building the next product on this database.
See [the architecture and code map](docs/architecture.md) for the ingestion flow, incremental matching, and module responsibilities.

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

## Configuration is mandatory

`config/default.json` is the explicit, committed configuration, despite the framework's conventional filename. **There are no application-level configuration fallbacks or schema defaults.** Root environment variables override it through Nextsignal's `NEXTSIGNAL_` provider. Missing or unknown values fail startup with the relevant configuration path. The web server, workers, scripts, migrations and tests use the same validation.

```dotenv
NEXTSIGNAL_SCHEDULER__CRON=0 12 * * 1
NEXTSIGNAL_APP__TIMEZONE=Europe/Skopje
NEXTSIGNAL_SOURCES__SPAR__CRON=0 12 * * 1,4
NEXTSIGNAL_MATCHING__AI__ENABLED=true
NEXTSIGNAL_MATCHING__AI__API_KEY=your-key
NEXTSIGNAL_MATCHING__AI__MONTHLY_BUDGET_USD=5
NEXTSIGNAL_MATCHING__AI__RUN_BUDGET_USD=null
```

An explicit source cron of `null` selects the configured global cron. The browser origin must be explicitly included in `auth.allowed_origins`, including its port. Spending caps of `null` mean no application cap. Apply environment changes with `docker compose --env-file .env.local up -d --force-recreate web worker`. A plain container restart keeps its previous environment. JSON configuration changes require `docker compose --env-file .env.local up -d --build` so both runtimes load the same values. A changed schedule resets its persisted next occurrence.

`matching.ai.enabled` is explicitly `false` in the committed configuration. Enable it and supply your own key to run paid matching. Price ingestion and conservative deterministic matching work independently. Provider failures or spending limits leave listings separate and eligible for another matching attempt. Usage costs include conservative reservations for requests whose final provider usage could not be obtained; they are estimates, not invoices.

This initialized checkout also keeps bulk AI disabled in `.env.local` during development, with an explicit $0.25 monthly cap and $0.10 per-run cap. The supplied key is preserved. A small live development evaluation can opt in for that command only: `NEXTSIGNAL_MATCHING__AI__ENABLED=true npm run matching:evaluate`. Enabling the background worker's paid matching requires changing its environment configuration and recreating the worker.

Other controlled settings include queue concurrency/retries/heartbeats, host request intervals, byte/time/page limits, source page sizes and identity policy, catalog reduction confirmation, logging retention, dashboard paging, and AI model/reasoning. The Decisions endpoint has no reasoning-effort parameter; `high` applies to Responses extraction only. `config/build.json` contains explicit non-runtime validation values for building Docker images; actual runtime secrets are always required separately.

For internet-facing deployment, explicitly enable `auth.secure_cookie`, terminate HTTPS at your reverse proxy, and configure its origin consistently. Compose binds the application and database ports to loopback. `APP_ENV_FILE` chooses the runtime environment file; keep it consistent with Compose's `--env-file` argument.

Request intervals are required per host under `http.host_intervals_ms`; discovered hosts without configuration fail visibly. The SPAR API advertises a 1,000-request rate limit, and its configured interval is 200ms (at most five requests/second). Stokomak and Žito use 500ms; the remaining hosts use 1,000ms. The shared Žur/Dim endpoint has one shared limiter across workers.

Schedules use five-field cron expressions. `scheduler.tick_cron` and `scheduler.tick_ms` explicitly configure the required one-minute framework bridge; retailer schedules are evaluated by those durable ticks. An existing discovery or catalog run blocks another scheduled ingestion for that retailer; after it finishes, the configured catch-up policy governs the missed occurrence. Matching does not block price refreshes.

## Data and processes

- `web`: Next.js dashboard and thin authenticated Nextsignal API routes.
- `worker`: Nextsignal background host; pg-boss queue and durable scheduler adapters use the owned PostgreSQL database.
- `migrate`: ordered, advisory-locked SQL migrations before startup.
- `postgres`: PostgreSQL 17 with persistent storage and `pg_trgm`.

Each retailer has its own `catalog.<retailer>.retrieve` business process and `catalog.<retailer>.job` queue consumer. Their concurrency is explicit in `queue.concurrency`. Discovery uses `catalog.job`; matching uses `catalog.match`, so a long catalog cannot prevent other retailers or matching from progressing. `catalog.request` creates discovery runs. Discovery records published scopes and durable pending catalog runs; publication and matching requests are committed together. Source and run locks make repeated deliveries safe, and older runs cannot replace a newer publication. The database pool is validated against the configured consumers' advisory-lock requirements; the queue pool has its own explicit size.

Catalog pages and checkpoints are stored transactionally in staging. Occurrence counters are recovered from indexed staging rows, keeping checkpoints small even for large catalogs. A complete validated catalog atomically replaces offers for its source. Empty or substantially reduced catalogs require an identical independent confirming retrieval. A failed confirmation retains the existing publication. Changed snapshot timestamps or advertised counts, incompatible page sizes, and identity-policy changes create a fresh durable run instead of continuing a mixed checkpoint. This recovery is atomic and idempotent, preserves the last publication, and is bounded by the explicit `queue.retry_limit`; exhausting it leaves a visible failure. Snapshot restarts retain their ingestion budget family. Empty-catalog confirmations inherit the same restart count.

The database separates `listings`, current branch/catalog `offers`, and shared `products`. Original strings and source fields remain available. All prices are exact PostgreSQL numeric MKD values. The configured invalid-price policy can preserve an unparseable price as `null`, with its raw source text retained; the dashboard displays **Unknown**, never zero. Historical price series are not stored. Run, matching and logging audit records are retained independently.

Retailer article codes stay within their source namespace. Sources without reliable unique identifiers use descriptive identity or the published article code and a persisted occurrence counter; ambiguous duplicates are excluded from automatic linking. Different named variants never get collapsed merely to make an import pass.

Matching is incremental. A listing's identity hash excludes prices, availability, promotions and retrieval timestamps. An unchanged identity keeps its existing shared product, attributes and saved matching result, including abstention. Known ambiguities are recorded without model calls in bounded database batches controlled by `matching.ambiguity_batch_size`; model work has its separate `matching.batch_size`. Recurring imports check new or changed identities; new listings can connect to existing products. Provider failures remain eligible for configured retries. The dashboard's matching retry explicitly reopens unresolved listings while preserving established connections. Model requests are cached by request content, endpoint, model and prompt version across branches. Repeat-import regression tests verify zero provider calls and unchanged shared product IDs.

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
npm run matching:evaluate       # paid; requires AI explicitly enabled and a key
npm run probe -- spar ramstore  # live first-page diagnostics; updates captured fixtures

docker compose --env-file .env.local logs -f worker
docker compose --env-file .env.local restart worker
```

The shadcn/ui dashboard has five screens: Overview for statistics; Products for store → catalog → product browsing and universal product groups; Data updates for monitoring imports and matching jobs; Tasks for starting imports, matching and retries after choosing a scope and reviewing the work; and Logs for correlated events with severity colors. Browsing and monitoring never start background tasks directly. Product details show store listings, catalog prices and readable matching history. Only Logs exposes JSON. Filters and pagination survive reloads and browser navigation. It uses a single configured administrator with signed HttpOnly sessions. APIs are authenticated except health/login; mutation requests check their Origin.

PostgreSQL is configured with 1GB of shared memory in Compose; the container runtime's 64MB setting is insufficient for aggregate queries over the full branch catalog. Server memory, connection limits, WAL size, compression and checkpoint cadence are required `POSTGRES_` values in the environment templates. The initialized configuration uses 256MB shared buffers and an 8GB WAL limit to avoid continuous checkpoints during the initial backfill. Review these explicit resource values for the deployment host.

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

`npm test` never truncates the application database and explicitly disables live AI. It covers all nine parsers, money/encoding/identity, catalog replacement and provenance, locks/recovery, cron/DST/catch-up, configuration failure, sessions, log-spool replay, incremental matching, and mocked AI failures/budgets/cache. The live 18-pair evaluation at 0.99 accepted two correct pairs, with zero false links and 25% recall on labeled positives. This small corpus is a regression check, not a statistical accuracy guarantee. `matching:evaluate` records both precision and missed matches under `.data/`.

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

`catalog_browser` is an indexed read model. Publication marks it dirty, and the
worker refreshes it after the current import wave finishes. The product screen
shows its refresh time and pending refresh state. This avoids repeatedly joining
millions of branch records just to display a page. Every table API returns its
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

## Free matching before optional AI

`matching.local` defines a versioned dictionary of brand and token aliases,
ignored words, and a bounded indexing batch size. The worker indexes unique
retailer articles in batches. Matching requires a recognized brand, unambiguous
quantity, consistent units, and an exact canonical token signature. Remaining
flavor, fat percentage, variant, and package tokens all participate; similarity
alone never authorizes a local match. Unknown attributes stay unknown. This
conservatively trades coverage for precision without a paid API or local model.

Indexing progress is visible in Overview. Initial indexing can take several ticks;
some records intentionally have no local signature. Bump `matching.local.version`
after changing rule dictionaries to reindex existing entries. Existing saved
connections remain stable; a source identity change or explicit unresolved retry
controls reconsideration.

Local candidate lookup works on one representative per retailer article, and
committing a safe match includes identical branch copies. An unchanged identity
reuses its attributes and matching result across branches. Known conflicts still
block whole-group merges. All methods retain evidence, including `local-rules`.

Paid AI is **disabled** in the initialized environment. If explicitly enabled, only
remaining eligible identities proceed to it; cached requests are reused, and
`max_requests_per_run` / `max_requests_per_month` bound paid requests in addition
to the configured dollar caps. The committed request limits are 10 per ingestion
family and 100 per billing month. Reservations, including interrupted requests,
count toward those limits. Enabling AI can still encounter a large unresolved
backlog, so leave it off unless you deliberately want a bounded paid pass.
