# Architecture and code map

The application has two runtimes: Next.js serves the private dashboard and APIs;
NextSignal's worker executes ingestion and matching. Both load the same required,
validated configuration and use the same owned PostgreSQL database. pg-boss keeps
the queue durable without another database or queue service.

## Where to change behavior

| Responsibility                                                          | Location                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Required configuration and startup validation                           | `config/default.json`, `nextsignal/config.ts`                       |
| Framework composition and service registration                          | `nextsignal/app.ts`, `nextsignal/services/index.ts`                 |
| HTTP transport                                                          | `app/api/**/route.ts`                                               |
| Authentication, input validation, API orchestration                     | `nextsignal/processes/api/operations.ts`, `tasks.ts`, `brands.ts`   |
| Catalog discovery, retrieval and failure orchestration                  | `nextsignal/processes/business/catalog.ts`                          |
| Named retailer retrieval processes                                      | `nextsignal/processes/business/retrieve.ts`                         |
| Queue consumers and pending-run dispatch                                | `nextsignal/processes/distributed/jobs.ts`                          |
| Recurring minute bridge                                                 | `nextsignal/processes/recurring/catalog.ts`                         |
| Run lifecycle, duplicate protection, snapshot recovery                  | `nextsignal/services/run-repository.ts`                             |
| Download/save reservations, fair selection, live concurrency limits     | `nextsignal/services/import-dispatch.ts`                            |
| Saved Overview totals and transaction-safe invalidation                 | `nextsignal/services/product-statistics.ts`                         |
| Discovery persistence, staging, complete-catalog publication            | `nextsignal/services/catalog-repository.ts`                         |
| Retailer HTTP/PDF protocols                                             | `nextsignal/services/importers.ts`                                  |
| Parsing published fields                                                | `nextsignal/services/parsers.ts`                                    |
| Text, quantities, identity hashes, attribute conflicts                  | `nextsignal/domain/normalize.ts`                                    |
| Facts, categories, identity and complete-group rules                    | `nextsignal/domain/matching.ts`                                     |
| Matching workflow coordination                                          | `nextsignal/services/matching-workflow.ts`                          |
| Store products, aliases, campaigns, claims, transactional group commits | `nextsignal/services/matching-repository.ts`                        |
| Gateway HTTP, typed decisions/extraction, cache and budget ledger       | `nextsignal/services/ai-gateway.ts`                                 |
| External store/category prompts and archived prompt bundles             | `nextsignal/services/matching-prompts.ts`, `prompts/`               |
| Human product corrections, audit and bounded group access               | `nextsignal/services/product-details.ts`, `store-product-groups.ts` |
| Dashboard queries and operator actions                                  | `nextsignal/services/operations.ts`                                 |
| Operational schedules, catch-up and reviewed task authorization         | `nextsignal/services/tasks.ts`, `task-settings.ts`                  |
| Retention cleanup                                                       | `nextsignal/services/scheduling.ts`                                 |
| Brand records, spellings, revisions and audit                           | `nextsignal/services/brands.ts`, `brand-catalog.ts`                 |
| Infrastructure: auth, logs, queue, scheduling                           | `nextsignal/adapters/`                                              |
| Dashboard state, API requests, user actions                             | `app/dashboard.tsx`                                                 |
| Login, overview, filters, tables, view-specific cells                   | `app/_components/dashboard/`                                        |
| Separate background host                                                | `worker/index.ts`                                                   |

Routes stay thin. Processes call services through the framework context. Services
own SQL and external integration details; adapters implement the framework's
infrastructure contracts. Dashboard components receive configuration-derived values
as props and never import server configuration, secrets, or database modules.

## Ingestion

1. A reviewed manual import or an authorized occurrence in the saved operational
   schedule creates a durable task. Its captured scope and permissions govern its
   discovery/retrieval runs. The recurring bridge dispatches authorized work.
2. The Discover catalogs task records published branch or shared catalog links
   without downloading their prices. Import prices creates retrieval runs for its
   selected catalogs, with pinned source URLs and named retailer processes.
3. The retailer importer yields pages. Each page and its checkpoint are committed
   together to staging, allowing durable retries to resume.
4. Complete downloads release their download reservation and wait for a separate
   publication slot. Two downloads may overlap; one final save runs at a time.
   A bounded ready buffer stops new downloads while the database catches up.
5. Publication checks completeness, advertised counts, and publication ordering.
   Empty or unexpectedly reduced catalogs need an independent identical retrieval.
6. A transaction updates current offers only after validation, adding new entries
   and removing absent entries. Unchanged product descriptions reuse saved facts
   and aliases; new branch copies reuse their chain product. It preserves saved
   assignments for unchanged source identities, maintains store-product aliases and compact prices, and writes durable new/changed-product work. No network model calls occur in publication.
7. Committed product changes mark saved dashboard statistics for a local worker
   refresh. Overview serves those totals and their timestamp without recounting
   millions of observations in an HTTP request.

Failed or incomplete replacements preserve the last successful catalog. Changed
snapshots restart from a fresh run within the configured retry limit. Run and source
locks prevent concurrent execution from corrupting publication. Timestamp ordering
is evaluated in PostgreSQL so sub-millisecond differences remain significant.

## Cross-store matching

Read [matching.md](matching.md) for the detailed walkthrough and review commands.

The matching unit is a chain/article/descriptive revision, independent of physical branches. `synchronizeSource` prepares its canonical store-product records inside catalog publication. There is no application migration/backfill stage before a task can run. Original source observations and accepted groups remain intact. Revision fingerprints exclude prices, availability, promotions, timestamps and branch IDs. Descriptive changes preserve the previous revision and record affected work; saved operational permissions determine whether that work may run automatically. Removed offers do not remove matching memory.

`matching-workflow.ts` coordinates source checks, rule facts, saved Decider categorization, candidate retrieval, deterministic proof, independent Decider questions, optional targeted Qwen clarification, and a complete-group commit. Categorization is a separately authorized task; unchanged branch copies reuse saved category results. Code-based matching applies to every category. Each manual AI matching task captures its chosen saved categories; automatic AI matching uses the categories saved in operational settings. Products without saved categories remain waiting rather than being secretly categorized by a matching task. An empty category selection allows no paid comparisons. Categories do not establish product identity. Unknown distinguishing facts remain unknown. Every positive connection must pass source-supported fact checks, regardless of its model probability. Read [category-first-matching.md](category-first-matching.md) for the full flow and review points.

`matching-prompts.ts` validates all required external instruction files at startup and composes only relevant store/category guidance. Provider usage and decisions reference archived prompt bundles. Classification history is append-only, independent of the AI category selection and price observations; changing the selection does not invalidate saved category answers.

`matching-repository.ts` owns SQL. `recordResult` locks a short graph commit, checks work ownership, source/group revisions and active source records, and validates every member together. Groups contain at most one distinct current product per chain. Competing source entries cannot win by processing order. Connections update canonical rows and redirect old shared IDs; they do not rewrite millions of branch copies. Membership and decision history are retained.

`ai-gateway.ts` owns `/v1/evaluate` and `/v1/chat/completions`. It validates native answer schemas and strict source-supported extraction, caches actual payloads, reserves shared campaign/monthly allowances before HTTP, and records reported usage afterward. Interrupted calls with uncertain billing retain their reservation and cannot be silently replayed. Selected-option probability and provider confidence are separate values. No photos, searches or hidden provider fallbacks are used.

Product tasks recover saved Gateway responses from the cache before checking for an outstanding reservation. Confirmed, unbilled HTTP 429 rejections receive bounded retries with permissions, availability and spending/request caps checked on every attempt. A shared PostgreSQL circuit breaker counts new provider failures across tasks and batches. Three consecutive failures, exhausted rate-limit retries, or a failed recovery probe start a cooldown: 60 seconds initially, doubling to a maximum of 900 seconds. Only one pending request may probe recovery after the cooldown. Success restores normal processing; failure extends the wait. Probe leases expire after a worker interruption, and stale responses cannot clear a newer probe. Saved/cache responses do not count as proof that the provider has recovered.

When the operation is Automatic, the affected authorized task enters **Cooling down** with a durable next-retry time. The scheduler wakes it only if current permissions and its original authorization still allow work. It keeps its original scope, selected products, spending and request limits. Manual mode requires explicit resume after a provider pause. A person can pause a cooling task, and global pause freezes recovery; disabling AI or switching out of Automatic holds the task for explicit action. Credentials, provider credits and spending/request limits remain hard stops. No transaction is held during a provider call and no timer sleeps inside a worker while cooling down.

HTTP 5xx failures, interrupted responses and missing billing receipts leave the affected product **Deferred**, retaining its possible charge and supporting later manual correction or receipt recovery. They are never silently retried as unbilled. **Retry deferred** revisits only that task’s selected failures and cannot expand an unlimited original task or reset its allowance. Existing paused tasks and uncertain ledger entries are not rewritten by migrations 038/039.

Automatic categorization can include the existing available backlog after explicit activation in Settings. Migration 039 preserves an already-saved Automatic choice without activating new backlog work; “Review activation” followed by “Activate automatic categorization” records the consent and current automation epoch in the settings history. Selecting Automatic from another mode includes that activation in its normal settings save. AI permission is still independent. Matching retains its change-triggered scope. Backlog selection uses the durable store-product layer, excludes unavailable products, respects saved human/agent categories, reuses current model results and does not take selected unfinished products from paused/running tasks. Deferred revisions remain held until explicit recovery or genuinely changed product information. One automatic task per stage is created at a time; completed categorization batches immediately hand off the next authorized batch, while paused automatic tasks cannot be bypassed by creating replacements. Startup, migration and deployment never themselves authorize this new backlog behavior.

One matching consumer processes bounded durable items, checkpoints progress, and releases unfinished claims on pause/failure. The initial batch size is 50 and is constrained by the task's reviewed and live settings. Provider calls run outside database transactions. The initial defaults are $25 across the entire initial campaign and $2 per Europe/Skopje calendar month for incremental work, further constrained by each task's allowance. Budget exhaustion retains work and requires an explicit resume with the applicable allowance available; a calendar change alone does not bypass a paused task. An uncertain reservation still blocks replay until reconciled.

The recurring bridge authorizes work from persisted operational settings. Queue handlers require durable task authorization and recheck live permissions at safe boundaries. Fresh deployments start with manual operation modes and AI permission off. Standalone model evaluations remain isolated from application data and require an explicit paid argument before provider calls.

## Brands and reference rules

| Data or rule                                             | Authoritative source                                                | How it changes                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Brand ID, canonical slug and display name                | PostgreSQL `brands`                                                 | Authenticated edits with optimistic revisions and audit history.                                                                  |
| Alternate brand spellings and optional store scope       | PostgreSQL `brand_aliases`                                          | Reviewed edits reject conflicting global/store spellings.                                                                         |
| Product's current brand connection                       | `store_products.brand_id` with the supported `facts.brand` evidence | Publication/fact edits retain the source quote and connect known canonical values to stable IDs. Unknown brands stay unconnected. |
| Initial brand dictionary                                 | `reference-data/brands.json`, seeded by migration 040               | Initializes reference records once; application startup does not overwrite database edits.                                        |
| Character decoding, units, packaging and identity safety | Versioned domain rules                                              | Reviewed code and tests, kept separate from editable reference names.                                                             |

`brand-catalog.ts` loads database spellings, applies store scope and snapshots the
dictionary for a product-processing batch. The domain layer receives explicit
rules and does not query PostgreSQL. Pure tests use an explicit starter fixture;
application services use the persisted dictionary.

Brand names and aliases support search, filtering and readable product details.
They do not prove that products have the same size, variant or sellable identity.
Display-name changes preserve the canonical slug, product evidence and saved
classification request inputs. Adding a spelling makes it available to future
processing without automatically launching paid work or resetting categories.
Brand edits are separately audited and do not change automation settings.

## One production execution path

Reviewed Tasks are the production entry point for imports, categorization and
matching. The old raw run-creation/retry operations, per-retailer scheduler,
listing-based local indexer, run-based matcher and store-product migration
backfill have been removed. There is no dormant OpenAI/Luna client or accepted
model-compatibility configuration block.

`services/scheduling.ts` now owns retention cleanup only. The minute bridge uses
`tasks.ts` and `task-settings.ts` for schedules and authorization, and
`task-context.ts` rechecks permissions at safe boundaries. Isolated test helpers
can arrange domain matching examples but are not registered in the application.
The evaluation CLI uses the shared rules and Gateway client in a separate test
database with explicit paid opt-in.

Applied migrations and saved observations, decisions, redirects and corrections
remain historical data. Removing obsolete runtime execution paths does not
rewrite that history or reset previously authorized work.

## Operating boundaries

All tunable values are explicit configuration. Missing or unknown values fail
startup. JSON and environment changes must be applied to both web and worker as
described in the README.

See [logging.md](logging.md) for operational events and debug tracing. `adapters/log-context.ts` carries the injected NextSignal logger and correlation/run/campaign/product context through services, keeping concurrent operations separate.

Database logs include correlation and run identifiers. The logger uses a persistent
local spool during database outages and replays records idempotently. Operational
and debug retention are configured separately.

The schema distinguishes original branch `listings`, current scope-specific `offers`, durable `store_products`, and shared `products`. A shared online catalog retains retailer scope; it does not
assert physical branch prices. See [the data model](data-model.md) and generated
`.data/coverage.md` for provenance and coverage details.

## Verification

Use `npm run check` and `npm test` after process, repository, matching, or config
changes. Tests use a separate database and disable paid AI. The existing suite
covers publication safety, concurrency, snapshot recovery, scheduling, matching
reuse, provider failures, parsers, authentication, configuration, and log recovery.

For UI changes, build the production image and run `npm run smoke` and
`npm run browser:smoke` against the running application. The browser smoke exercises
login, each dashboard view, product details, and navigation without triggering imports
or paid matching.

## Product browsing and local matching read models

`nextsignal/services/dashboard-read.ts` owns paginated operations reads.
`catalog-browser.ts` refreshes the indexed `catalog_browser` read model only after
an import wave finishes. It aggregates identical retailer article/identity copies,
retains scope counts and price ranges, and exposes its own freshness. Source
listings and offers are retained. The worker marks publication changes in
`catalog_browser_state`; it does not rebuild the view from HTTP requests.

`store_product_browser` uses canonical store rows and `store_product_sources` compact price summaries. Reads can retain original branch records without a canonical alias, but never migrate or prepare them as a side effect. Matching reads the canonical layer directly and does not wait for a materialized-view refresh. `domain/local-matching.ts` provides pure reviewed token signatures using the current database brand dictionary. The separate listing-index service and run-based matching entry point have been removed. Dashboard local-rule coverage is computed from current store products and their local keys, not a retired listing-index table.

Counts, product searches, group selection, and manual counterpart searches use
`store_product_identity_browser`, which checks current availability without
aggregating branch prices. Product pages select identities first, then hydrate
only that page from `store_product_browser`. The parameterized hydration boundary
prevents the query planner from aggregating the entire catalog before pagination.
Overview counts reuse one visible identity set, and matching coverage reuses one
active product set. Its shared in-flight cache cannot expire until the read
finishes; the configured freshness window starts at completion. Reads never
trigger imports, matching, or browser-index refreshes.

The client request hook in `app/_components/dashboard/use-dashboard-data.ts`
cancels obsolete requests, keys results by view and filters, debounces search, and
refreshes configured views only after their prior request settles. Static product
browsing does not poll in the committed configuration. Exact totals and matching
view identifiers are part of the shared `domain/dashboard.ts` response contract.

## Dashboard navigation and product details

The dashboard has six screens: Overview (statistics only), Products, Review,
Observability, Run Tasks, and Settings. Observability combines Data updates and
Logs. Run Tasks owns manual launches and pause/resume controls; Settings owns
schedules, automation permissions, thresholds, spending and brand reference data.
An explicit scope selection and review dialog precede imports, categorization
and matching. Retry links in Data updates open a draft in
Tasks without submitting work. The review shows the scope, effects, matching/AI
behavior, and where progress will appear. Submission stays locked while pending.
The catalog selector loads every page for the selected store and aborts obsolete
requests when the store changes. Store availability and matching capabilities come
from the validated deployment and saved operational settings. Products combines the store → catalog → store-product hierarchy with an
All products mode. All products groups the indexed store articles by their current
universal product assignment; filtering a group by store or name retains all of its
connected stores and its complete price range. A catalog drill-down shows that
catalog's own current price, rather than the aggregate price across branches.

`services/product-browser.ts` owns universal-product reads and product details.
The authenticated `products.details` API process exposes `/api/products/[id]`,
resolves redirected identities, and returns store products, scoped observations,
and recent matching decisions with readable candidate names. Matching history, supported facts and plain-language uncertainty reasons are presented inside product details. Legacy conflicts are visibly flagged. Canonical group/source indexes avoid repeatedly scanning branch records for universal grouping. Group totals and pagination are computed in one database
snapshot, and prices/store badges are aggregated only for the selected page.

The dashboard uses shadcn/ui (Radix Nova), Tailwind v4, and semantic status colors.
`use-navigation.ts` persists screens, filters, catalog selection, and pagination in
the URL, including browser Back/Forward. Detail sheets preserve the underlying
screen. Tables keep a fixed viewport while paging, and the request hook retains
previous rows only within an identical filter scope. Obsolete requests are aborted.
Only log details render JSON. Store logos are local assets in `public/stores`.

Product spelling normalization is shared by imports, search, candidate lookup,
and local matching keys. Legacy Macedonian glyph mappings, protected punctuation,
normalization versioning, and the existing-database reindex command are described
in [name-normalization.md](name-normalization.md). Source names and identity hashes
are retained; the reindex service changes only derived spelling fields.

Human-confirmed cross-store connections live in the existing product details
Matching tab. Authenticated `products.manualSearch` and `products.manualSave`
processes call `services/manual-matching.ts`; append-only manual pair decisions
are reused by both candidate checks and full-group commits. These edits share the
automatic commit lock, invalidate stale work, and make no AI calls. See
[manual-matching.md](manual-matching.md) for persistence, undo, logging and
configuration. Automatic matching has its own saved permission and starts off on
a fresh deployment. The bounded experimental model comparison is documented in
[glyph-vs-qwen-2026-10-23.md](glyph-vs-qwen-2026-10-23.md).

## Operational controls

The minute bridge now dispatches authorized task roots and their import children; it does not sweep legacy runs or call global matching/backfill helpers. Runtime operational choices live in PostgreSQL and are checked at safe checkpoints through `task-context.ts`. Required configuration only seeds the missing settings record. See [Tasks and gradual activation](task-controls.md) for the execution and permission model.

Import capacity is reserved before publication by `services/import-dispatch.ts`.
Stores take turns, source retries release their slots until a durable next-attempt
time, and `services/source-health.ts` shares host cooldowns between workers. Queue
tokens and advisory locks protect active work while surviving workers recover
expired orphan reservations. Explicit resume preserves successful catalogs and
saved pages; it creates a bounded new cycle only for failed downloads. See
[Import reliability and recovery](import-reliability.md).

## Manual categorization review

The **Review** sidebar screen reads saved classification scores through
`products.reviewCategories` and `services/category-review.ts`. It prioritizes
uncertain results, also supports inspecting assigned/human categories, and reviews
unique store products rather than branch copies. One-click choices, quick approval
checks, and Undo reuse the authenticated category-edit process and its durable
audit history. See [Manual category review](manual-category-review.md) for score
ordering, checkpoints against concurrent changes, and keyboard controls.
