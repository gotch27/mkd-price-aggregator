# Reliable imports and recovery

Imports keep their original task authorization, store selection, completed catalogs,
and page checkpoints. Restarting the worker does not grant permission for new work.

## Stores take turns

The dispatcher reserves capacity in PostgreSQL before publishing a queue message.
The reservation includes a unique token; obsolete or duplicate deliveries cannot
start a second download. Download and final-save reservations use separate queues.
The default is two downloads overall, up to two from one chain, plus one final
database save. Both the reviewed task limit and the live settings constrain
execution; lowering either limit also holds already queued excess work. Among
eligible stores, the store served least recently goes next.

A completed download returns its slot before joining the final-save queue. At most
four complete/in-flight catalogs occupy the ready buffer, so downloads cannot grow
an unbounded publication backlog. A database save can retry from its complete
checkpoint without another source download. Shared PostgreSQL locks enforce one
publication even across multiple worker hosts or direct service calls.

Temporary download failures save a future retry time on the run, release the slot,
and allow another store to proceed. They do not sleep inside a retailer queue or
spend attempts repeatedly competing for a busy slot. With a retry limit of five,
six failed requests **without a successfully saved page** stop the catalog. Saving
a page resets that failure allowance. `attempts` counts execution starts, including
normal continuation turns; it is not the failure budget. Restart recovery preserves
the page cursor, current failure count, and future retry time.

Within a store, fully downloaded catalogs get priority for publication; otherwise,
healthy partial downloads continue before fresh catalogs, which still precede due
failed retries. This finishes a small continuing set instead of opening dozens of
partial SPAR snapshots that can all become obsolete together. Fair turns between
chains remain in place. Long catalogs save progress
and yield after twenty-five pages or thirty seconds at a page boundary. Those
limits never truncate a catalog or publish incomplete prices.
Queue polling is one second. Only complete, validated catalogs replace offers.
Missing `done` checkpoints and `done=false` share the same non-ready priority;
only `done=true` receives publication priority. A partial download cannot jump
ahead of an untouched catalog because one checkpoint field is missing.

New Stokomak snapshots request twenty products per page. New Žito snapshots use
one hundred after bounded comparisons returned complete 100-row pages in roughly
the same time as 20-row pages. Both sites advertise 10, 20, 50, and 100 as supported
sizes. Already started snapshots retain their recorded page size, so a deployment
cannot reinterpret a saved page cursor or skip products. An unexpectedly empty
later page is a bounded retry, not a successful end of a catalog or an immediate
permanent failure. The cursor advances only after a valid page is saved.

Product-identity checks use the partial `listings_ambiguous_observation` index to
look for problematic current observations. A chain with no flagged observations
does not scan every branch listing to prove that normal identifiers are clean.
For chains with flagged observations, parameterized existence checks stop at the
first active proof instead of aggregating all branch copies. Inactive or removed
offers cannot establish a problem, and saved identity information for wholly
inactive products is retained. Group conflicts and matching rules are unchanged.

## Download health

Health is shared in PostgreSQL, so all workers respect a host's cooldown and
`Retry-After`. Three consecutive failures start a five-minute cooldown, increasing
up to thirty minutes after further failures. Healthy stores remain available.
A successful complete response clears failures only if no newer request recorded
a failure; an older response cannot erase a newer server rate limit.

The published-price platform can also return a plain-text upstream connection
error with HTTP 200. Known `Error fetching organizations/products/articles`
connection failures are rejected before marking the host healthy or parsing the
body. They use the same bounded retry/cooldown policy as HTTP/network failures.
Logs retain HTTP status 200 and `phase=provider_response`, with the provider
operation and failure kind. Provider payloads and internal addresses are not
copied into application logs. A genuine catalog-layout change remains a separate
validation failure; this check does not bypass completeness rules.

Connection establishment has a thirty-second limit. Active downloads have explicit
per-host total limits (KAM ninety seconds, Stokomak two minutes, other configured
hosts one minute). A response that stops sending bytes for twenty seconds is
aborted. The dedicated source HTTP dispatcher does not change AI Gateway behavior.
Incomplete responses are never published as complete catalogs. Response bodies are
released even when storing download health fails; unavailable health storage holds
work safely.

Required deployment settings live under `http` in `config/default.json`, with root
environment overrides documented in the example files. No source endpoint or key
is configured through a task payload.

## Pause and resume

1. **Pause all work** prevents the next external request. An in-flight request or
   catalog transaction may finish.
2. Individually paused tasks stay paused when the global pause is removed.
3. **Resume** continues pending catalogs and gives failed catalogs a new bounded
   retry cycle. A failed import/discovery task exposes **Retry unfinished**.
4. Successful catalogs are kept. Failed attempts remain in history, linked to
   replacement runs. Saved page data is retained for unfinished authorized tasks,
   including while a task is paused.

Existing task permissions are preserved during migration. Resuming an import from
Tasks explicitly reviews and adopts the current overall/per-store download limits;
the account, settings revision, and before/after limits are saved. It never expands
store scope, AI permission, or spending allowances.

Removing the global pause alone does not resume an individually paused task.
An unavailable store can still fail after its allowed attempts; the app cannot
make an external server available, but that store must not block healthy stores.

## Logs

- `catalog.retry.scheduled`: one warning per temporary failed request, including
  store/run/source, failures without saved progress, next attempt, network code, phase,
  received bytes, and configured deadlines.
- `catalog.run.failed`: final error after failures without saved progress, or a permanent
  source failure.
- `source.cooldown.started` / `source.cooldown.recovered`: shared host health.
- `catalog.retry.deferred`: a cooling host was skipped without making a request or
  consuming another attempt.
- `source.http.*`: debug detail for individual request start, completion, failure.
- Task pause/resume, queue cleanup, and repair events use the existing log adapters.
- `catalog.turn.yielded`: saved pages handed the slot to another catalog. This
  is progress, not a failed request. Tasks reports saved pages in unfinished
  catalogs separately from complete catalogs, waiting catalogs, and failures.
- `catalog.publication.started` / `catalog.publication.indexing`: downloaded
  prices are being prepared and checked; publication is not committed yet.
  `catalog.publication.completed` includes `phase_durations_ms` for validation,
  preserving product memory, preparation, store records, branch prices, and
  product indexing. Existing page events include `staging_ms`.
- `catalog.download.completed`: complete pages are saved and waiting for a
  publication slot. Tasks shows downloading, waiting to save, and saving separately.
- `catalog.dispatch.inactive_skipped`: queued work for a retired source was
  resolved locally, preserving its recorded history. Active handlers are protected
  by the delivery, run, and source locks.
- `catalog.publication.interrupted`: a temporary database problem retained the
  download for a bounded save retry.
- `dashboard.statistics.refreshed` / `dashboard.statistics.failed`: local saved
  Overview totals were rebuilt, or the last valid totals were retained.

## Avoiding repeated database work

Price-only updates retain unchanged listing rows, product facts, revisions, groups,
and manual corrections. New branch copies reuse an existing chain product rather
than creating another shared-product row. Only changed or missing source mappings
are indexed. Current offers are updated in place; only offers absent from a
complete, validated replacement are deleted. Retrieval times and run provenance
still update for every observation.

Overview reads saved product totals instead of counting the full product/branch
tables on each request. Committed product changes request a local worker refresh,
at most once per configured refresh interval. The UI shows the snapshot timestamp
and whether a refresh is pending. Invalidation is transaction-safe: a refresh
removes only events visible in its own consistent snapshot. A later commit cannot
be accidentally marked as already counted. Refresh failure preserves the last
valid totals and pending events. This derived-data refresh grants no permission
for imports, matching, or AI.

Expected source failures are result envelopes between processes. They no longer
produce repeated generic system-error entries at each process boundary. Unexpected
application failures remain errors.

## Product warning and pack corrections

Duplicate source identifiers are safety information, separate from descriptive
product revisions. Repeated occurrences remain distinct; a duplicate in one active
branch keeps that article unsafe for automatic matching. Actual contradictory
product descriptions still open a conflict.

Pack extraction requires a complete, supported expression such as `2×500 ml`,
`38/1`, or an explicit piece count. Length dimensions such as `35×26 cm` do not
establish a pack count. Targeted AI clarification obeys the same evidence rule.
Manual corrections take precedence.

The following bounded maintenance tools default to dry runs and require global
pause when `--apply` is supplied. They never start imports, matching, or AI calls:

```sh
npx tsx scripts/repair-product-identities.ts --batch-size 250 --max-products 10000
npx tsx scripts/repair-product-packs.ts --phase store-products --batch-size 250 --max-products 20000
npx tsx scripts/repair-product-packs.ts --phase listings --batch-size 1000 --max-products 100000
```

Review the counts before adding `--apply`. Each committed batch records a cursor;
`--after <cursor>` resumes a capped or interrupted correction. Identity repair
preserves original IDs, history, manual edits, and connections. Conflicting human
decisions are left for review rather than automatically consolidated.
