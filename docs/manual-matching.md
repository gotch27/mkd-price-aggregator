# Manual matching

Open **Products → Details → Matching**. Search another store by product name,
review every member of the proposed group, and save the connection. You can add
an explanatory note. The operation makes no model calls.

**Separate** moves one store product into its own group and remembers that it
differs from every remaining member. A deliberate manual reconnection replaces
that choice; the earlier choice remains in history. Known conflicting amounts,
variants, packs and other supported facts still prevent a connection. A group
cannot contain two current distinct products from one chain.

## Persistence and imports

- Migration `017_manual_product_matches.sql` adds append-only pair decisions,
  linked to the existing decision and membership history.
- The latest pair decision applies to the exact saved store-product revision.
  There is no expiry or periodic deletion of this memory.
- Price changes, new physical-branch observations and unchanged returning
  products reuse the saved store product and connection.
- A meaningful description change creates a different revision. The previous
  connection remains in history but cannot automatically validate a changed size
  or variant.
- Old branch matching fields cannot override a later manual correction.
- Automatic candidate checks reuse saved separations before paid comparison.
  The final transaction also checks separations across the entire proposed
  group, preventing an indirect merge from bypassing a saved separation.
- A manual positive decision supplies human identity confirmation where source
  facts are missing. It never overrides an explicit known difference.

Manual edits and automatic commits share the group advisory lock. The UI sends
snapshots containing member revisions, group version and supported facts. An
outdated snapshot is rejected. Manual changes invalidate pending automatic
claims. Transactions use serializable isolation and never contain provider calls.

## Module boundaries

- `nextsignal/domain/manual-matching.ts`: client-safe request/result types.
- `nextsignal/services/manual-matching.ts`: bounded reads, legacy identity
  preparation, transactional connections and separation.
- `nextsignal/services/manual-match-memory.ts`: latest pair decisions.
- `nextsignal/processes/api/operations.ts`: authenticated and validated
  `products.manualSearch` / `products.manualSave` processes.
- `app/api/products/[id]/matching/route.ts`: thin GET/POST route.
- `app/_components/dashboard/manual-matching.tsx`: shadcn search and confirmation
  interface, source-supported facts, readable failures and saved feedback.

Browsing is read-only. Saving a legacy selection prepares just those identities
and their branch copies, within the configured bound; it does not start a whole
database backfill or matching campaign. Conflicting legacy connections require
indexing/review before editing. The existing automatic/Gateway switches remain
independent of manual editing.

## Logging and settings

Adapter events: `matching.manual.searched`, `requested`, `connected`, `separated`,
`reused`, `rejected`, and `failed`. API context carries process name and correlation
ID. Events identify the actor and affected products, without logging credentials,
free-form notes or provider payloads. Notes are visible in the saved history.

`matching.manual` requires candidate, member, minimum-search and note-length
limits through the existing config system. Both root environment examples and
defaults document these settings.

## Verification

`npm test` includes manual persistence, removal/return, branch copies, stale
answers, explicit conflicts, deliberate undo, on-demand legacy indexing and old
branch-field compatibility. `npm run smoke` checks read authorization, input
validation and cross-origin protection for the manual endpoint. Browser checks
use an isolated local dataset, including saving a connection, separating it,
and rejecting Original versus Zero. No real product connection is edited by
these checks.

Counterpart search is paginated in the database: five groups per page by default
(`matching.manual.candidate_limit`). The API requires a positive `page` and returns
page size, eligible-group totals and page count. Existing same-store members are
excluded before counting or paging. The count, selected page and group snapshots
share one read-only database snapshot. Pages are sorted by name and ID; requests
past the end clamp to the last page. Search and store changes start at page one.
The shadcn paging controls sit above a fixed-height results area, retaining the
sheet position while page content changes. Obsolete requests are aborted.
Result cards keep their natural height inside that scroll area, so product names,
store logos, supporting facts and the review button remain visible. Single-store
results do not have a repeated generic group heading. Results are explicitly
labelled as search results, not confirmed matches. Manual search respects whole
word/phrase boundaries after normalization and reviewed alias expansion: `kanta`
can find `КАНТА` but does not retrieve `КАНТАРИОН` or `ПИКАНТА`.
