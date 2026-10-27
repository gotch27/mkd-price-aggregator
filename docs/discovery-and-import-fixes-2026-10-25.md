# Discovery and import fixes — 25 October 2026

This delivery addresses the confirmed bugs from the discovery/SPAR review.
Physical locations, coordinates, addresses and catalog-to-location links remain
outside this update.

## Correct discovery and existing metadata

- Vero uses surrounding store-card headings. The malformed empty anchors for
  Jumbo 2/3 no longer bypass exclusion. Fourteen Vero supermarket catalogs remain.
- Ramstore uses readable card/button names and keeps them over path-only fallbacks.
  HOME outlet labels remain distinct metadata. Catalog IDs and URLs are preserved.
- SPAR extracts the heading, city and store number separately. Legacy characters
  in Latin display text become readable forms such as `Kočani` and `Štip`;
  original text and genuine Cyrillic remain available unchanged.
- `source-discovery-repair.ts` corrects existing records without creating sources,
  runs, imports or matching work. Dry run is the default. Apply requires stopped
  import execution/reservations and pause/offline worker state, checked again under
  the dispatcher transaction lock. Each committed change logs before/after values.
- Site-proven Jumbo sources become inactive, and their unfinished work is resolved
  locally. Existing prices, listings, source IDs, groups and history remain stored.
  Dispatcher, retrieval and publication guards prevent retired catalogs from
  continuing to import through an old queue message.

The maintenance command is:

```sh
node --import tsx scripts/repair-source-discovery.ts
node --import tsx scripts/repair-source-discovery.ts --apply
```

Review the dry run and stop imports before the apply command. It reads only the
three configured public catalog-listing pages, never their price catalogs.

## Task reliability and scoped retries

`import-task-guards.ts` serializes overlap checks with insertion/resumption. A
second import covering a queued/running store/catalog is rejected with a useful
message. Distinct scoped catalogs and exact idempotent replays remain valid.
Scheduled work skips stores occupied by manual imports.

Active reviewed imports/discovery tasks offer **Retry failed**, with an explicit
store selection in the existing review dialog. Only those stores' failed work
receives another bounded retry allowance. Successful work, AI permissions, task
limits and source scope do not expand. The command is serialized with task-progress
updates; retries cannot race finalization or silently become another full import.

`import-progress.ts` derives totals, actual unresolved errors and retry candidates
from explicit confirmation/replacement links in one task. A resolved KAM quarantine
can no longer hide failed Stokomak/Žito discovery. Rejected complete confirmations
restart with fresh snapshots rather than replaying rejected staging.

## SPAR/database work

Healthy partial catalogs continue ahead of new catalogs within a chain, retaining
fairness between chains, due-retry fairness, source cooldowns, page checkpoints and
the one-publication limit. This reduces the number of partially downloaded
snapshots exposed to a publisher version change.

Known chain products no longer go through a canonical-product UPSERT for every
new branch copy. Missing records, legacy-match preservation and concurrent inserts
retain their existing protections. Branch-specific offers, observations, aliases,
source safety checks, saved facts and manual matches are unchanged.

No unverified assumption about identical prices between branches or reliable
publisher version caching was introduced. Whole-import throughput was not tested
by starting a new full campaign.

## Verification

All 425 isolated tests passed, including captured malformed HTML, metadata repair
rollback/idempotency, history preservation, concurrent overlapping starts, scoped
retries, quarantine chains, inactive-source locks, partial-download scheduling,
and canonical-row reuse under real concurrent row locks.

Type checking passed. The production Turbopack Docker images built successfully on
the homelab. Local Turbopack was blocked by the desktop sandbox's process/port
restriction; the production image build provided the production compiler check.

## Homelab rollout

The reviewed correction updated 112 existing metadata records, including exactly
two Jumbo exclusions. Vero now has 14 active supermarket catalogs. All 21,863
previous Jumbo offer rows remain stored; no product/price/matching history was
deleted. Ramstore has no path-only names, and SPAR has no button text in its saved
names. The worker was stopped and its reservations recovered before applying the
transaction, with no settings permission changes.

The new web/worker images are healthy at `https://prices.gocheski.com`. HTTPS health,
login, Overview, corrected task errors, protected reads, and validation of the new
retry command were checked. The original failed task displays Stokomak/Žito as its
unresolved failures. The existing second manual import continued and saved new
pages after deployment. Task count stayed at two, settings stayed at revision one
with manual operations and AI off, and AI usage stayed zero. No new application
errors appeared during deployment verification.
