# Architecture and code map

The application has two runtimes: Next.js serves the private dashboard and APIs;
Nextsignal's worker executes ingestion and matching. Both load the same required,
validated configuration and use the same owned PostgreSQL database. pg-boss keeps
the queue durable without another database or queue service.

## Where to change behavior

| Responsibility                                                | Location                                            |
| ------------------------------------------------------------- | --------------------------------------------------- |
| Required configuration and startup validation                 | `config/default.json`, `nextsignal/config.ts`       |
| Framework composition and service registration                | `nextsignal/app.ts`, `nextsignal/services/index.ts` |
| HTTP transport                                                | `app/api/**/route.ts`                               |
| Authentication, input validation, API orchestration           | `nextsignal/processes/api/operations.ts`            |
| Discovery, retrieval, matching, and failure orchestration     | `nextsignal/processes/business/catalog.ts`          |
| Named retailer retrieval processes                            | `nextsignal/processes/business/retrieve.ts`         |
| Queue consumers and pending-run dispatch                      | `nextsignal/processes/distributed/jobs.ts`          |
| Recurring minute bridge                                       | `nextsignal/processes/recurring/catalog.ts`         |
| Run lifecycle, duplicate protection, snapshot recovery        | `nextsignal/services/run-repository.ts`             |
| Discovery persistence, staging, complete-catalog publication  | `nextsignal/services/catalog-repository.ts`         |
| Retailer HTTP/PDF protocols                                   | `nextsignal/services/importers.ts`                  |
| Parsing published fields                                      | `nextsignal/services/parsers.ts`                    |
| Text, quantities, identity hashes, attribute conflicts        | `nextsignal/domain/normalize.ts`                    |
| Candidate selection, matching decisions, safe group updates   | `nextsignal/services/matching.ts`                   |
| OpenAI requests, caching, usage reservations, spending limits | `nextsignal/services/ai.ts`                         |
| Dashboard queries and operator actions                        | `nextsignal/services/operations.ts`                 |
| Cron evaluation, catch-up, retention                          | `nextsignal/services/scheduling.ts`                 |
| Infrastructure: auth, logs, queue, scheduling                 | `nextsignal/adapters/`                              |
| Dashboard state, API requests, user actions                   | `app/dashboard.tsx`                                 |
| Login, overview, filters, tables, view-specific cells         | `app/_components/dashboard/`                        |
| Separate background host                                      | `worker/index.ts`                                   |

Routes stay thin. Processes call services through the framework context. Services
own SQL and external integration details; adapters implement the framework's
infrastructure contracts. Dashboard components receive configuration-derived values
as props and never import server configuration, secrets, or database modules.

## Ingestion

1. A configured cron occurrence or authenticated manual action creates a discovery
   run. The recurring bridge dispatches persisted pending runs to their queues.
2. Discovery records each published branch or shared catalog and creates retrieval
   runs with pinned source URLs. Every retailer retains its named process.
3. The retailer importer yields pages. Each page and its checkpoint are committed
   together to staging, allowing durable retries to resume.
4. Publication checks completeness, advertised counts, and publication ordering.
   Empty or unexpectedly reduced catalogs need an independent identical retrieval.
5. A transaction replaces current offers only after validation. It preserves saved
   assignments for unchanged listing identities and creates a matching run.

Failed or incomplete replacements preserve the last successful catalog. Changed
snapshots restart from a fresh run within the configured retry limit. Run and source
locks prevent concurrent execution from corrupting publication. Timestamp ordering
is evaluated in PostgreSQL so sub-millisecond differences remain significant.

## Incremental product matching

`matchBatch` reads as a sequence of named steps: resolve the scope, record known
ambiguities, select due identities, evaluate listings, and commit checked decisions.

The listing identity hash excludes price, promotion, availability, and retrieval
time. A repeated import with the same identity preserves its shared product,
attributes, and saved decision. Such a listing does not enter normal matching again.
A new listing can still connect to an existing shared product.

For new or changed identities:

1. Record known ambiguity as abstention in a bounded bulk transaction.
2. Try validated GTINs or complete, unambiguous fingerprints.
3. For remaining candidates, use OpenAI only when explicitly enabled. Cache requests
   across branches and reserve configured spending before requests.
4. Recheck identity hashes and whole-group attribute compatibility under row locks
   before connecting products. Persist the method, evidence, and model metadata.
5. Leave uncertainty separate. Provider failures remain eligible for configured
   retries; an explicit operator retry can reopen unresolved identities.

`commitDecision` owns the final transactional check. This keeps slow provider work
outside database transactions while preventing stale evidence from merging changed
listings. Publication also preserves the live assignment when a concurrent matcher
has already connected an unchanged listing.

## Operating boundaries

All tunable values are explicit configuration. Missing or unknown values fail
startup. JSON and environment changes must be applied to both web and worker as
described in the README.

Database logs include correlation and run identifiers. The logger uses a persistent
local spool during database outages and replays records idempotently. Operational
and debug retention are configured separately.

The schema distinguishes retailer `listings`, current scope-specific `offers`, and
shared `products`. A shared online catalog retains retailer scope; it does not
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

`domain/local-matching.ts` computes conservative exact keys from the required
configured brand/token dictionaries. `services/local-matching.ts` indexes bounded
batches of unique retailer entries and queues free matching work. The matcher
checks whole groups, including identical article copies in other branches, before
committing. AI remains separately opt-in and has explicit request-count limits as
well as spending reservations.

The client request hook in `app/_components/dashboard/use-dashboard-data.ts`
cancels obsolete requests, keys results by view and filters, debounces search, and
refreshes configured views only after their prior request settles. Static product
browsing does not poll in the committed configuration. Exact totals and matching
view identifiers are part of the shared `domain/dashboard.ts` response contract.

## Dashboard navigation and product details

The dashboard has five screens: Overview (statistics only), Products, Data updates,
Tasks, and Logs. Tasks owns manual launches: an explicit scope selection and review
dialog precede imports and matching. Retry links in Data updates open a draft in
Tasks without submitting work. The review shows the scope, effects, matching/AI
behavior, and where progress will appear. Submission stays locked while pending.
The catalog selector loads every page for the selected store and aborts obsolete
requests when the store changes. Store availability and matching capabilities come
from the existing server configuration. Products combines the store → catalog → store-product hierarchy with an
All products mode. All products groups the indexed store articles by their current
universal product assignment; filtering a group by store or name retains all of its
connected stores and its complete price range. A catalog drill-down shows that
catalog's own current price, rather than the aggregate price across branches.

`services/product-browser.ts` owns universal-product reads and product details.
The authenticated `products.details` API process exposes `/api/products/[id]`,
resolves redirected identities, and returns store products, scoped observations,
and recent matching decisions with readable candidate names. Matching history is
presented inside product details; the matching algorithm is unchanged. The covering
`listings_browser_product` index avoids scanning wide branch listing records for
universal grouping. Group totals and pagination are computed in one database
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
