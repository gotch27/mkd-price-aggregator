# Operational logging

Repeated source rows now emit `catalog.duplicates.collapsed` after publication,
with source/unique/duplicate counts. `catalog.prices.conflicting` warns when one
catalog publishes different prices for the same store product; all observations
remain stored. Explicit local repairs use `catalog.duplicates.repaired`,
`prices_refreshed` and `repair_failed`. Product-task checkpoints include category
counts. See [source-product-duplicates.md](source-product-duplicates.md).

All new matching/import events use the existing NextSignal logging adapter. `nextsignal/adapters/log-context.ts` carries the process logger, correlation ID and identifiers through asynchronous service calls. It does not implement another sink. The registered adapter still owns severity filtering, secret redaction, database persistence, console output and the outage spool.

API commands, scheduled work and worker runs bind their NextSignal context. Nested matching/Gateway calls retain it and add campaign, store-product, work and request identifiers. Standalone scripts use the same adapter. Concurrent runs cannot overwrite each other's context.

## Events and levels

| Area               | Default operational events                                                                                                                                         | Debug tracing                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import publication | Current offer counts, changed store-product records, work queued/restored, preserved legacy observations; source conflicts and failed/quarantined publication      | Skipped publication                                                                                                                                        |
| Campaigns          | Created, queued, paused, resumed, completed; spending/provider/disabled pauses                                                                                     | Waiting for imports/indexing, no pending work                                                                                                              |
| Matching work      | Batch start/completion with counts/duration; unexpected failure; expired claims recovered                                                                          | Claimed/released/finished work and stale completion                                                                                                        |
| Product matching   | Incompatible proposed groups produce warnings                                                                                                                      | Product revision/family, candidates/retrieval reasons, rule checks, model choices/probability/confidence, saved connections, uncertainty and stale answers |
| AI Gateway         | Rejected/uncertain billing, provider failures and spending-limit deferrals | Request start/completion, model, estimated/reported cost, numeric token usage, generation ID, duration, cached responses and source-supported clarification fields                                                                                 |
| Backfill           | Committed checkpoint/cursor, processed/queued counts, completion, conflicting legacy records and failures                                                          | Product-level details remain in their durable history                                                                                                      |

Stable identifiers such as `gateway.request.completed` appear in `data.event`. Messages remain readable in Logs. `run_id`, `retailer` and `source_id` populate the existing indexed log columns; campaign/product/work/request identifiers live in the structured data. Probability for the selected option, probability of “same”, and provider confidence remain separate values.

For example, one traced product can show candidate retrieval → rule checks → AI request completed → candidate decisions → clarification if needed → group connected/rejected/stale → work checkpoint saved. At the normal info level, task/batch summaries, spending and failures remain visible. Successful request milestones are debug events; the durable usage ledger still records every charge. Categorization results are available from the task’s View results button rather than operational logs.

`matching.candidates.checked` records each checked outcome, its specific missing/conflicting fact or probability threshold reason, and the configured threshold. `matching.product.facts_refreshed` identifies queued products whose derived facts changed under the current rules; it does not launch a database-wide refresh. `gateway.clarification.fields_rejected` is a warning listing rejected fields and their validation reasons alongside independently retained fields. One unsupported model or quote no longer discards a valid brand; an amount and its unit still pass or fail together. These events use the same adapter and scoped campaign/product/work identifiers.

Category-first matching adds debug events `matching.classification.saved`, `.stale`,
`.reused` and `matching.category.excluded`. They distinguish a new category answer,
a stale answer, a saved answer reused without AI, and code-only matching outside
selected labels. `matching.classification.queued` and `matching.categories.requeued`
are info events summarizing bounded queue changes. Gateway traces include the
operation and archived prompt hash, without printing prompt content.

## Commit and failure behavior

“Published”, “connected”, “completed”, and checkpoint events are emitted **after** their database transaction commits. A rolled-back publication cannot leave a success event. Provider request-start events describe attempts; completion records reported billing, while failure distinguishes an explicit rejection from uncertain billing with a retained reservation. A cached response does not create another paid-call event.

Logging failures do not turn a committed match or successful billed response into a business failure. If an injected process logger fails, the standard adapter records a logging fault; its existing spool handles database outages. Operational logs are retained under the existing logging policy. Product decisions, membership history and usage accounting remain separate durable records.

No prompts, request/response bodies, auth headers, API credentials or claim tokens are added to Gateway logs. Numeric `input_tokens`, `output_tokens` and `total_tokens` remain visible; credential/token strings are still redacted. Request IDs are content hashes, not API keys.

## Inspecting logs

Use the existing Logs screen with severity, correlation, run, source and retailer filters. Details contains the structured event data. To opt into product tracing, set root `NEXTSIGNAL_LOGGING__LEVEL=debug` and reload the affected runtime as described in the README. It follows the existing debug retention setting. This delivery does not change the configured logging level or enable matching.

The isolated logging tests cover context isolation, adapter injection, redaction, numeric usage, cache reuse, spending/provider failures, logging-sink failures, source validation, recovered work, lifecycle transitions, monthly resume, severity filtering, and transaction rollback. They mock provider calls; no live paid request is required.

Dashboard reads emit `dashboard.read.completed` at debug level with view, store,
catalog, page, and elapsed milliseconds through the authenticated process's log
context. Product-detail reads emit `products.details.loaded` with the product ID,
duration, and whether it was found. Search text and full product records are not
copied into these timing logs.

Manual matching uses the same adapter through `withLogContext` in the authenticated
API process. Events `matching.manual.requested`, `connected`, `separated`,
`rejected` and `failed` record the actor, scope and result; `searched` and `reused`
are debug events. Free-form notes remain in decision history rather than logs.
A save failure never reports a successful connection. Experimental model requests
reuse Gateway reservation, completion/rejection and cache events in the isolated
matching database.

Product detail edits use the authenticated process logger through the same context
adapter. `products.details.updated` is info and includes author, retailer, product
IDs and before/after changes after the transaction commits. `rejected` is warn,
`failed` is error, and `unchanged` is debug. Their durable audit history is separate
from log retention. See [product-detail-editing.md](product-detail-editing.md).

Task controls use the same adapters: `tasks.settings.saved` includes the actor, revision and before/after field changes; `tasks.authorized` records the reviewed scope/limits; batch, pause/resume, restart recovery and held legacy delivery events carry task/run identifiers. Gateway usage additionally carries the owning task ID. Settings history remains durable even when operational logs expire.

Source downloads emit `source.http.failed` debug detail with host, HTTP status,
received/advertised bytes, duration and retryability. Request start and successful
completion are debug events. These events omit response bodies and request
credentials. The timeout covers both receiving headers and downloading the body;
an interrupted body remains a retryable source failure. The owning run emits one
`catalog.retry.scheduled` warning with those diagnostics and its attempt/next-time
metadata, or a `catalog.run.failed` error when retries are exhausted. Expected
source failures do not become generic system errors at nested process boundaries.
Shared host cooldown/recovery events explain waits across workers. Final Tasks reasons show
the store's actual failure instead of a generic “needs attention” message.
`tasks.import.finished` records the final discovery/import summary. Discovery
success reports the number of catalogs found without downloading their prices.

The task worker publishes newly initialized catalog runs directly, so discovery
need not wait for a second scheduler tick. Initial task pickup still uses the
configured scheduler and queue polling intervals; no extra background loop is
introduced. Publication is scoped to the authorized task and serialized per run.

Retailer downloads use a dedicated HTTP dispatcher with an explicit
`http.connect_timeout_ms` (30 seconds) instead of the client's implicit 10-second
connection limit. `http.timeout_ms` remains the 60-second overall deadline,
including body download. Both are required centralized configuration values,
with root `NEXTSIGNAL_HTTP__CONNECT_TIMEOUT_MS` / `NEXTSIGNAL_HTTP__TIMEOUT_MS`
overrides. This dispatcher does not change AI Gateway calls.

Source failure events retain the nested network error code/message, the failure
phase, and both configured deadlines. For example, `UND_ERR_CONNECT_TIMEOUT`
means the connection was not established in time; a successful HTTP status with
partial received bytes means a body download failed. Increasing a timeout cannot
repair an unreachable host, a reset connection, or a stalled remote server.
