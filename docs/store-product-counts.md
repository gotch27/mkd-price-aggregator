# Store cards and product-count investigation — 25 October 2026

Availability has since been audited across all catalogs and added to store cards,
product filters and task eligibility. See [Product availability](product-availability.md)
for the available/unavailable breakdown, KAM parser correction and workflow rules.

Each Products → By store card shows **Unique products** and **Price observations**
side by side. The logo has no added border. The header combines the logo and
store name, with catalog count and browsing/import information retained.

Unique products count active store-product identities once across a chain's
catalogs. Prices, physical branch copies and repeated source rows do not create
additional store products. This is a count of the store's published identities,
not a claim that every item is currently in stock or that source data is perfect.
Two chains' entries for the same Coca-Cola still each count in their own store.
Cross-store matching connects them without reducing either store's count.

Price observations count all current published source rows, including branch
copies and repeated source rows. Removed catalog offers do not count, while
saved product and matching memory remain retained separately. Products still
listed but marked unavailable do count.

## Measured production data

| Store | Unique store products | Price observations |
| --- | ---: | ---: |
| SPAR | 84,531 | 4,451,410 |
| Vero | 33,828 | 193,755 |
| Ramstore | 23,486 | 253,681 |
| Žito | 16,504 | 450,443 |
| Žur | 9,786 | 108,227 |
| Stokomak | 7,158 | 210,617 |
| Dim | 6,260 | 90,093 |
| Reptil | 5,773 | 5,773 |
| KAM | 3,723 | 148,594 |
| **Total** | **191,049** | **5,912,593** |

SPAR contributes about 44.2% and KAM about 1.9% of store-product identities.
Each active identity also has a distinct stored article key within its chain;
there is no repeated-key/branch inflation in these totals. Distinct normalized
names are close to the identity totals (SPAR 83,018; KAM 3,698). Different article
keys with the same name are retained conservatively rather than automatically
declared equivalent.

The largest imported SPAR catalog, **SPAR M.76 Ilinden**, has 80,989 rows and
80,989 different original source IDs. Of those rows, 11,521 are marked available
and 69,468 unavailable; only five have a zero price. The large total therefore
reflects a broad published catalog containing many unavailable products, rather
than 80,989 products proven to be on that branch's shelves. This availability
breakdown is for that one catalog, not for the chain as a whole.

For comparison, the largest imported KAM catalog contains 2,074 rows, all marked
available. Different branches together contribute 3,723 distinct products.
Every active catalog has a successful import recorded. Some successfully
published catalogs are empty; no unseen/unattempted import explains the large
distribution difference found here. These checks used saved imported records,
not a new pull from supermarket sites.

## Implementation and verification

Migration 033 adds a nullable `retailer_counts` field to the existing dashboard
snapshot and requests a local refresh. The worker computes store totals from
the same active store-product layer, in the existing repeatable-read snapshot
transaction. Summary requests only read the saved map; they do not recount
millions of offers per page load or start external work. Before its first
refresh, an unknown count displays “—”, not a false zero.

Regression coverage verifies branch deduplication, unchanged per-store counts
after cross-store grouping, unavailable products, inactive catalogs, distinct
article identifiers, missing initial snapshots, concurrent invalidation and
failed-refresh recovery. Browser-facing summary reads retain their lightweight
query path. No imports, categorization or matching tasks are created by counts.

All 459 isolated tests, strict type checking and the production Docker build
passed. Migration 033 and the UI were deployed. Authenticated HTTP verification
confirmed all nine counts and that KAM/SPAR/Vero product browsing with all name
qualities returns the identical totals. Summary reads measured 43 ms initially
and 2 ms cached. Public HTTPS and container health passed. AI requests and saved
classifications remained 3,723, task count remained 5, and the saved settings
revision 7 policy was unchanged. No new external work was started for this update.
