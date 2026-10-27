# Product availability and paid-work eligibility

Only products explicitly reported available in at least one active catalog can
enter categorization or matching tasks. A task scoped to one catalog requires
availability in that catalog. Unavailable and unconfirmed products stay saved,
with all previous category decisions, manual corrections and matches retained.
No price, name, positive price or presence in a catalog is treated as proof of
availability. An unavailable product can still have a published price.

Availability is the supermarket's claim at import time. It is not a live stock
check or a guarantee that a customer will find an item on a shelf. Reptil's
public online catalog is shared; it does not establish physical-branch stock.

## Source audit — 25 October 2026

The audit read current saved offers across every active catalog, each source's
headers, original product rows and API field names. Availability is explicitly
supplied by all nine publishers:

| Store | Published availability field |
| --- | --- |
| KAM | PDF “Достапност” column, Да/Не; column positions vary by page |
| Ramstore | Fifth table column, “ДОСТАПНОСТ НА ПРОИЗВОД” |
| Stokomak, Žito | Fifth table column, “Достапност во продажен објект” |
| SPAR | API `available`, string 1/0 |
| Vero | Fourth table column, “Достапност во продажен објект” |
| Dim, Žur | Sixth table column, Да/Не, after their article-code column |
| Reptil | WooCommerce `is_in_stock` boolean |

The initial chain-level audit found SPAR with 29,325 available and 55,206
unavailable identities; Vero with 31,572 available and 2,256 unavailable; and
Reptil with 4,163 available and 1,610 unavailable. KAM had 3,719 available and
four unknown. The other five chains had no unavailable/unknown identities in
their current imported catalogs. A product counts as available if any branch
says yes, even when other branches say no. The earlier figure of 69,468
unavailable SPAR rows referred to one branch, not the whole chain.

The four unknown KAM products exposed a parser bug. Page headings shift their
column positions, and wrapped descriptions were being appended to the stock
cell. Their original PDF lines explicitly say Да. The parser now reads each
page's headings and keeps availability from the product's primary row. The
saved-data repair only corrects missing availability values whose exact raw PDF
lines match reparsed source evidence. It does not change prices, names, IDs,
categories or matches. Future imports use the corrected column parsing for all
fields; genuine descriptive changes follow the existing revision rules.

## Information retained and limits of normalization

Every imported row retains its original table cells, PDF lines or public API
object in `listings.raw`. Available source names, descriptions/categories,
article identifiers, barcode where explicitly supplied, selling/regular/promo
prices, unit-price text, availability, promotion text and source timestamps are
normalized for the application. Table codes are not assumed to be barcodes.
The complete KAM PDF text and first table pages are also retained as artifacts.

This does not mean every provider field already has a dedicated UI field.
Reptil, for example, also supplies brand arrays, weight/dimensions, attributes,
variation/purchasability metadata and full HTML descriptions. Those remain in
the original object; not all are promoted into supported matching facts. SPAR's
discount metadata and table-specific promotion/points cells likewise remain in
the original data where not represented separately. Images remain unused by
matching. Missing source information must stay unknown, not be guessed.

## Persistence and execution

Migration 034 adds nullable `store_product_sources.available` and
`sources.availability_indexed_at`. Null or unindexed data is ineligible.
Within duplicate source rows, any explicit yes wins; all explicit no gives no;
no yes with any unknown remains unknown. The `store_product_availability` view
combines only active catalogs, and partial indexing makes available selection
independent of millions of original offers.

Publishing a catalog saves availability with prices in the same transaction.
A false/unknown/not-listed → available transition receives a fresh automation
grant only if that import was authorized for categorization/matching and the
live permissions still allow it. This covers a genuinely new available product
and an unchanged product returning to availability. It does not reset flags or
repeat paid decisions for products already categorized/matched. Price-only
updates and extra branch copies do not trigger another AI pass. Turning on a
switch does not sweep an old backlog.

Availability is enforced at selection, before each product, before a paid
request, again after budget reservation and before a group commit. Unsent
reservations are released if availability changes. Already in-flight requests
may finish; their saved answers remain reusable. A queued item that becomes
unavailable is shown as **Skipped**, not a permanent product difference.
Unavailable/unknown candidates are excluded from code and AI retrieval.
Previously saved group members remain in group safety checks and history.

`scripts/repair-product-availability.ts` is a deliberate, resumable local data
repair. No flags show pending sources; `--apply --all` derives availability
from saved offers, one source transaction at a time. It makes no supermarket or
model requests, does not grant automation and preserves completed checkpoints.
Detailed source progress uses debug logs; start/completion/failure use the
standard log adapters. No maintenance option is added to the Tasks UI.

## Interface

Store cards show available/unavailable/unknown counts alongside all listed
unique products and price observations. Product browsing defaults to available,
with filters for unavailable, unknown and all listed products. Product rows,
shared groups and product details carry explicit status labels. Branch prices
already had their original availability column, and retain it. Where some
branches report availability, displayed comparison ranges prefer those branch
prices over cheaper unavailable observations.

The default browsing filter is required configuration
`dashboard.product_availability`; changing a browsing filter never authorizes
AI for unavailable products. Manual category corrections retain their durable
human history and do not call a model.

## Delivery verification

The 475-test isolated suite passed, including provider-boundary cancellation,
availability changes before group commits, automatic new/restocked products,
cached category reuse and source repair. After the lookup optimization, 23
focused availability/statistics tests and 70 availability/browsing/integration
tests passed. Strict checking and production Docker builds passed. The corrected
parser read all 86 saved KAM catalogs (148,594 rows) without changing row counts.

Migrations 034/035 were applied. The resumable repair indexed all 420 saved
catalog records, including two currently inactive catalogs, and corrected exactly
four missing KAM offer flags using their original PDF evidence. Current active
totals are **131,977 available**, **59,072 unavailable**, and **zero unknown**
store-product identities. No task or automation grant was created by the repair.

Authenticated production reads verified stock filters, detail labels and the
per-store totals. SPAR available-product browsing returned 29,325 identities in
933 ms for a 30-row page; available shared-product browsing took 1,416 ms. Summary
reads stayed about 40 ms. Unavailable and unknown views are indexed as well;
they no longer scan every branch observation to establish missing stock values.

AI usage/classifications stayed at 3,723, tasks at 5, manual category edits at 1,
matching decisions at 0, store-product records at 212,051 (including historical
records) and original offers at 5,934,456. The saved revision 7 policy was
unchanged, and no active task was left running. Container/public HTTPS health
passed. No supermarket pull or paid model evaluation ran during delivery.
