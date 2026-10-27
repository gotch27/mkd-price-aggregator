# Catalog pipeline update — 25 October 2026

The previous all-store manual import finished during this update: all 420 active
catalogs are published, with 5,969,837 current branch price records. No replacement
campaign was started to test the new pipeline. Product information, corrections,
connections, and decision history are retained.

## Changes

- Separate download and publication queues. Two downloads are allowed overall,
  including two branches from one chain; final database saves are serialized.
- PostgreSQL reservations, phase-specific authorization, locks, and a ready buffer
  cap prevent duplicate work or unlimited downloaded catalogs waiting to save.
- Completed downloads retry database publication without fetching the catalog
  again. Download cursors and failure budgets survive restart and pause/resume.
- Existing task permissions are preserved. Explicit resume review can adopt the
  current overall/per-chain limits and records who reviewed the change.
- Unchanged descriptions reuse saved facts, listing rows, and source mappings.
  New branch copies reuse the chain product. Offers use insert/update/delete
  semantics while preserving current retrieval times and run provenance.
- Overview reads a saved, consistent statistics snapshot maintained locally by
  the worker. A failed rebuild retains the previous totals and pending changes.
- Tasks shows downloading, waiting to save, and saving separately. Settings expose
  both download limits, the ready buffer, and the single publication slot.

## Verification and activation

All 362 isolated tests passed, including concurrent mocked same-store downloads,
ready-buffer backpressure, restart/expired-lease recovery, reduced live limits,
publication retry without refetching, price-only/removed/returning offers, and a
real commit-order race in statistics invalidation. Type checking, production
builds, container health checks, and authenticated HTTP smoke checks passed.

Migrations 028 and 029 were applied and the new web and worker images deployed.
Saved policy revision 14 has imports, categorization, and matching set to manual;
AI remains off, scheduled stores remain empty, and global pause is removed. The
download limits are two overall and two per chain. Both existing tasks remain
completed; AI usage remains zero. No warnings or errors were recorded in the
post-deployment checks.

Before deployment, an Overview HTTP read took 9,952 ms. After deployment, a fresh
service instance read the same totals in 92 ms; observed HTTP reads took 27 ms and
3 ms. The initial worker snapshot rebuild took 10,962 ms outside the HTTP request.
These are local measurements, not a full-import throughput benchmark. No new full
import or paid model call was made for this update. Product list reads still took
several seconds in the HTTP checks; the Overview speedup does not establish an
equivalent improvement for every product search.

See [import-reliability.md](import-reliability.md) for operation and recovery.
