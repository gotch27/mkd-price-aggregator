# Discovery and SPAR import review — 25 October 2026

This review checked the supplied handoff against current code, public publisher
responses, the earlier research files, and read-only queries on the homelab.
No application code, production records, settings, or tasks were changed. No
import, matching task, or paid model call was started. Public-page/API reads were
bounded diagnostic requests.

## Discovery findings

| Finding | Verification | Priority |
| --- | --- | --- |
| Vero includes Jumbo | Confirmed in the parsed publisher HTML and live sources. Empty-text anchors for `119_1.html` and `168_1.html` bypass the anchor-text exclusion. Their surrounding cells identify Jumbo 2 and Jumbo 3. These active sources have 10,202 and 11,661 price rows recorded under Vero. | Correct classification first; preserve history and exclude incorrect current supermarket sources. |
| Ramstore names are URL paths | Confirmed for all 36 live sources. The publisher uses cards with readable headings, addresses, and buttons with `location.href`. The fallback records paths, and last-entry deduplication can replace better metadata. HOME is explicitly a separate outlet type on the publisher page. | Fix extraction/deduplication and classify outlet types. |
| KAM location metadata is discarded | Confirmed in code. The current read-only API response has 86 entries, 86 coordinate pairs, 86 addresses/cities, and 85 nonempty municipalities. Only address/unavailability currently survives discovery. | Preserve supplied metadata and provenance; keep missing values unknown. This is not a price-download failure. |
| Reptil physical locations are flattened | Confirmed. The API lists 30 entries: 28 markets and two kitchens, with one shared catalog URL. Live metadata retains only titles plus a notice that branch pricing is unverified. | Retain physical-location details/types. Keep the shared catalog downloaded once. Do not infer branch prices/availability from the link. |
| SPAR names include page controls | Confirmed in current HTML and database. The parent contains card numbering, an `h3` name, a city, and the price-list button. Current extraction concatenates them. | Extract fields separately and normalize legacy characters while retaining originals. |
| Locations and catalogs need separate identities | Confirmed as a missing capability, not a broken existing location table. Current `sources` are price sources. SPAR `/pricelist/10` is labelled M.12. DIM catalog ID 17 is labelled СТАЈКОВЦИ; its official locator labels the Stajkovci location DIM Market 1. Numbers alone cannot establish a location link. | Needed for reliable physical-branch/location features; not a prerequisite for chain-level product matching. |

The earlier 192 coordinate records remain publisher-provided research, not
independently verified locations or official current store totals. A missing map
pin does not establish that a catalog is invalid or a physical store has closed.
The Overview's current “Stores” metric counts chains; catalog coverage counts
price sources. Neither is a verified physical-location count.

Primary publisher evidence:

- https://pricelist.vero.com.mk/
- https://ramstore.com.mk/marketi/
- https://kam.com.mk/ShopsWeb/LoadShopList — read-only POST
- https://cms.reptilmarketi.mk/wp-json/wp/v2/pages/8
- https://spar.mk/pricelist
- https://dim.marketceni.mk/
- https://dim.mk/lokacii-na-dim/

## SPAR performance

The live workload has several measured causes:

1. **Volume:** 60 SPAR catalogs now have published data, totalling approximately
   4.45 million branch price records. Most catalogs contain about 74,000–81,000
   rows. At 500 products per request, one complete pass needs roughly 9,000 page
   requests, plus metadata requests. Matching descriptions being deduplicated by
   chain does not remove the need to retain branch-specific prices.
2. **Overlapping manual work:** all-store import tasks started at 09:55:13 UTC and
   10:33:33 UTC. The second started while the first was running. Both include all
   nine chains and all SPAR catalogs. At inspection, 41 second-pass SPAR catalogs
   had the same publisher version and row count as successful first-pass runs.
   This is evidence of repeat processing of the same advertised version, not a
   proof that all price payloads are byte-identical.
3. **A real publisher version change:** 41 first-pass runs were superseded with
   `Source changed during retrieval`. Saved versions changed from
   `2026-10-25T07:07:28.000000Z` to `2026-10-25T10:16:30.000000Z`. Replacement runs
   successfully published. The consistency guard should remain; optimizing the
   schedule can reduce how many partial catalogs are exposed to such a change.
4. **Database publication:** 68 observed SPAR publication events averaged 23.2
   seconds, with approximately 26.3 minutes of cumulative serial-save time. Some
   later saves took 37–49 seconds. Their phase logs put most time in listing writes
   and product/source indexing rather than page staging, which averaged 16 ms.
   Download turns and publications overlap, so their cumulative durations must
   not be added as a wall-clock estimate.

At inspection all 60 catalogs had published data; the remaining SPAR activity was
the second pass. New pages and completed publications were still being recorded.
The resource snapshot did not show the containers hitting their CPU/RAM caps;
there was no active blocked database statement in that snapshot. This does not
establish that resources are never busy, but increasing container limits is not
the first justified change from these measurements.

Recommended changes, before increasing concurrency:

- Detect overlapping catalog/store scope at task creation. Show the existing task
  and offer explicit retry of failed stores rather than another all-store pass.
- Reuse an already running catalog fetch where task authorization and snapshot
  semantics permit, with accurate progress for every owning task.
- Validate whether SPAR's version or conditional-response metadata reliably tracks
  all price/availability changes before using it to skip unchanged catalogs.
- Finish a bounded number of partial catalogs per chain before opening dozens
  more, while retaining fairness between chains and bounded page turns.
- Profile the listing-write and product-indexing phases using representative
  isolated data. Preserve all completeness checks, source provenance, prices, and
  matching/manual-edit history.

## Additional reporting bug

The first task finished with a KAM failure summary, while its actual failed runs
were Stokomak and Žito discovery. KAM's quarantined empty catalogs had successful
confirmation runs. `importTask()` correctly excludes those resolved quarantines
from its failure count, but the query selecting the displayed failure reason
includes every quarantined run. A recently resolved KAM quarantine can therefore
hide the real failure reason. Both queries should use the same unresolved-failure
rule. This affects reporting, not evidence that KAM's published data was lost.

## Suggested order

1. Correct Vero/Jumbo inclusion and the misleading task failure reason.
2. Prevent overlapping full imports and provide scoped retry controls.
3. Correct Ramstore/SPAR names and preserve already supplied location metadata.
4. Optimize SPAR retrieval/publication using the measured phases and safe reuse.
5. Add the independent physical-location model and evidence-backed catalog links
   before exposing location-based price comparisons.
