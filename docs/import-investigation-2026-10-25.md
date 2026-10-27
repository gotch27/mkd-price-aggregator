# Long import investigation — 25 October 2026

The existing manual task was advancing, but had avoidable scheduling, download,
and database costs. It was not deadlocked. The first inspection found 378 of 420
catalogs published and 5,794,224 current price observations. Eight chains were
complete; only Žito remained (52 of 94 catalogs). The task was authorized for one
concurrent import and AI remained off.

## Evidence

- SPAR's 60 committed publication events reported 14,153 seconds in total
  (about 3.9 hours), with a median of 231 seconds. This is database publication
  time, not download time. It includes several steps, not just identity checks.
- Žito's yielded download turns reported 11,814 seconds in total at inspection.
  Most snapshots used 20 products per request. A roughly 7,000-product catalog
  therefore required about 350 requests, plus database staging and publication.
- Žito page 209, organization 85, caused one permanent failure after 208 saved
  pages. A bounded recheck returned the expected 20 rows and the same advertised
  total of 7,012. This was a transient empty response, not proof that the rest of
  the catalog was invalid.
- Comparisons on organizations 85 and 90 returned complete 100-product pages in
  about 1.0–1.1 seconds. The 20-product requests took about 0.8–1.8 seconds.
  These are small diagnostic samples, not a provider reliability guarantee.
- Earlier connection timeouts and refusals were real and recovered. Shared host
  health was clear at inspection. Containers were healthy, no blocking database
  transaction was present, and pages were being saved at the inspection time.

Execution-turn durations include publication, so these totals must not be added
to publication totals as independent buckets. Elapsed task age also includes
previous maintenance pauses and deployments.

## Corrections

1. Normalize a missing `done` checkpoint to false in dispatch ordering. The old
   NULL ordering put partial downloads before untouched catalogs. Only a fully
   downloaded catalog should receive publication priority. A regression test
   reproduced the wrong selection before the fix.
2. Treat an unexpectedly empty later page as a bounded, retryable source error.
   Preserve the saved cursor, and never publish that response as a complete
   catalog. Retry logs identify the pagination phase and page number.
3. Use 100 products per request for new Žito snapshots. Existing snapshots retain
   their original size, including the failed catalog resumed from page 209.
4. Replace the all-observation ambiguity aggregation with indexed existence
   checks. Chains without flagged observations skip the normal branch records;
   other chains stop at the first current proof for each product. Inactive and
   removed offers cannot establish ambiguity, and wholly inactive product memory
   is retained. Group conflict rules and matching history remain unchanged.
5. Record publication start/indexing phases, final per-phase durations, and page
   staging durations through the existing logging adapters. Final publication
   success remains an event emitted after commit.

The final read-only identity-check comparison took approximately 0.3 seconds for
80,989 SPAR store products, versus a 15-second timeout for the previous query.
For 7,995 Žito store products, the previous query took 2.35 seconds and the new
query took 1.04 seconds. Both returned the same current change set. These timings
measure the identity check, not a complete publication.

The implementation uses isolated database tests and mocked provider responses.
The retry was authorized by resuming the existing task, retaining its 208 saved
pages; live verification observed it advance to 233 pages. No new import campaign,
AI matching, categorization, or paid model request was started.

After deployment, that retry completed and published all 7,012 products. Untouched
Žito catalogs started with 100-product pages, and one saved 2,500 products in its
first turn before yielding. The final verification passed all 345 isolated tests,
type checking, the production build, and the live HTTP smoke checks. The existing
task remained running with AI off.
