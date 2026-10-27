# Repeated source rows and categorization

The source row and the product are separate. Imports retain every original row,
price, availability, promotion, source URL and run reference for completeness and
traceability. A repeated row's occurrence suffix identifies an observation, not
another sellable product.

Matching and browsing use one store product for the same chain, original source
identifier and descriptive fingerprint. The first-occurrence key shape is kept
to preserve existing canonical IDs. Different names, sizes, variants, descriptions
or barcodes remain separate. Distinct publisher article identifiers are not
combined merely because their names look alike. Branches reuse the store product
and retain their own observations.

Identical commercial observations in a branch are shown once. The original
observations stay in PostgreSQL, with a duplicate count in the compact branch
summary. Different prices remain separate observations, with a price-conflict
flag and the full minimum/maximum range. Product details explain that the store
published conflicting prices; catalog-scoped browsing cannot select a random
occurrence's price. Ingestion completeness still checks the original row count.

An identifier repeated with genuinely different descriptions still prevents an
automatic exact-product connection. It no longer prevents the separate
categorization task. Categorization ends before retrieval or matching and can
assign a category without resolving exact identity. Task progress distinguishes
saved categories from checked items without a saved category.

## Existing imported records

`scripts/deduplicate-products.ts` is deliberate local maintenance. It never
downloads catalogs or calls AI. Dry run is the default; mutation requires a global
pause, checked in each transaction under the product-group lock.

```sh
node --import tsx scripts/deduplicate-products.ts --phase products --batch-size 100 --maximum 50000
node --import tsx scripts/deduplicate-products.ts --phase products --batch-size 100 --maximum 50000 --apply
node --import tsx scripts/deduplicate-products.ts --phase prices --batch-size 10 --maximum 500 --apply
```

Each batch prints a cursor; `--after UUID` resumes from a checkpoint. Retired IDs
remain resolvable through redirects. Original records, observations, decisions,
category history and human corrections are retained. If only one occurrence has
a protected correction or accepted connection, it becomes canonical. Competing
protected records remain separate and flagged; processing order cannot choose a
winner. Later imports respect that separation. No task or AI allowance expands.

## Logs

All events use the existing log adapter:

- `catalog.duplicates.collapsed`: original rows, unique product count, repeated
  product rows and identical commercial duplicates, after publication commits.
- `catalog.prices.conflicting`: number of branch products with different prices.
- `catalog.duplicates.repaired`: maintenance checkpoint and protected conflicts.
- `catalog.duplicates.prices_refreshed`: refreshed duplicate/price summaries.
- `catalog.duplicates.repair_failed`: last committed checkpoint on failure.
- `tasks.batch.started/completed`: categorization batch size, processed count,
  saved category count and items without a category.

Gateway requests, costs and failures retain their existing logs. Classification
answers and prompt versions are durably saved independently of debug log retention.

## Verification

Isolated tests cover repeats across pages and branches, exact and conflicting
price observations, scoped price ranges, distinct variants/barcodes/article codes,
unchanged canonical IDs, protected human edits, audit preservation, redirect
resolution, repair idempotency and classification without exact-product linking.
Providers are mocked; the checks make no live paid requests.

## Homelab rollout — 25 October 2026

The existing database was repaired under a temporary audited global pause. Active
store-product entries decreased from 208,686 to 191,049. There are no remaining
active source-ambiguity flags in this dataset. All 5,934,456 original listings,
price observations and listing aliases remain; 18,539 redundant product records
(including inactive history) have durable redirects rather than being deleted.
The active branch summaries record 100,734 identical repeated observations and
1,587 branch/product combinations with differing published prices.

All 433 isolated tests and type checking passed. Production Docker images built
successfully. Authenticated HTTP checks verified settings, Tasks, product lists,
real duplicate observations, conflicting-price notices and catalog-scoped price
ranges; public HTTPS health also passed. AI usage remains zero. No import,
categorization, matching campaign or live provider test was started.
