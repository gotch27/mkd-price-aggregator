# PriceCrab product-count investigation — 26 October 2026

## Finding

The two headline totals measure different units and different public catalog
scopes. Our available count is a sum of unique **store** entries; PriceCrab
publishes merged cross-store products. Production currently has no cross-store
connections. There is also direct evidence that PriceCrab retains non-grocery
products while excluding them from ordinary search results. These findings
explain why 131,977 versus roughly 57,400 is not an ingestion completeness test.
They do not establish an exact reconciliation of the two private databases.

## Evidence and method

Read-only PostgreSQL transactions on the homelab production database, with a
45-second statement timeout, inspected the saved snapshot, current active-source
availability, product identities, decisions and task types. Live PriceCrab pages
were inspected in a background browser. Web retrieval supplied additional public
references, but some indexed pages were stale: the live homepage showed 57,420
products and 16,189 comparable products, while web retrieval showed 57,428.

No application code, settings, production data or task permissions were changed.
No imports, categorization, matching, or paid model calls were started.

## Our production counts

| Chain | All listed store products | Available in at least one active catalog |
| --- | ---: | ---: |
| Dim | 6,260 | 6,260 |
| KAM | 3,723 | 3,723 |
| Ramstore | 23,486 | 23,486 |
| Reptil | 5,773 | 4,163 |
| SPAR | 84,531 | 29,325 |
| Stokomak | 7,158 | 7,158 |
| Vero | 33,828 | 31,572 |
| Žito | 16,504 | 16,504 |
| Žur | 9,786 | 9,786 |
| **Total** | **191,049** | **131,977** |

There are 59,072 unavailable store products and zero with unknown availability.
All current available entries have different internal article keys within their
chain. Counting distinct normalized names within each chain removes only 680
entries (0.52%); different keys with equal names are not necessarily duplicates.
This check does not rule out semantic duplicates with different names.

Across all chains, exact normalized-name grouping would reduce 131,977 entries
to 123,338. This is a diagnostic, not a safe merge rule: equal names can conceal
different sizes/variants, and equivalent products often have different names.

Both current available group count and available store-entry count are 131,977.
The snapshot has zero cross-store groups, zero matched records, and zero locally
indexed products. Both matching decision tables and changed-group history have
zero rows. Saved tasks comprise imports and categorization, with no match task.
Categorization therefore must not be read as completed product matching.

The counting definitions are in `nextsignal/services/product-statistics.ts`:
`available_store_products` counts available store identities, while
`cross_store_products` counts groups spanning multiple chains. The latter currently
uses all listed members, so any future public available-only comparison metric
should explicitly require available members in two or more different chains.

## PriceCrab grouping and the arithmetic

[Their explanation](https://pricecrab.mk/za-proektot) states that differently named
entries from different chains are connected into one product. Their
[release notes](https://pricecrab.mk/sto-e-novo) describe comparable products as
products appearing in two or more markets.

The live Coca-Cola search showed one classic 1.25 L product with nine retailer
offers. Our current data has eight separate available classic 1.25 L store entries
including Dim; these are not connected to each other. This is an example of the
unit difference, not an independent audit of every PriceCrab match.

16,189 comparable products does not mean only 16,189 redundant entries disappear.
Each shared group can replace several store entries. For illustration only:

| Assumed mean chains per comparable product | Store entries represented by 57,420 groups |
| --- | ---: |
| 4 | 105,987 |
| 5 | 122,176 |
| 6 | 138,365 |

Formula: `57,420 + 16,189 × (mean chains − 1)`. These means are hypothetical;
PriceCrab's actual group-size distribution was not measured. Underlying entries
can also differ from this simple model if a group contains several article codes
from one chain.

## Confirmed public filtering difference

Live [search for “панталони”](https://pricecrab.mk/prebaruvanje?q=%D0%BF%D0%B0%D0%BD%D1%82%D0%B0%D0%BB%D0%BE%D0%BD%D0%B8)
returned “Нема резултати” (no results), yet suggested trousers products. Following
[one suggestion](https://pricecrab.mk/p/28993-detski-zhenski-mashki-kratki-pantaloni)
showed “Детски Женски/Машки Кратки Панталони”, under
“Непрехранбени / Облека и обувки”, available in 61/80 Stokomak branches at 129 MKD.
Our current saved product has the identical name, source category “ТЕКСТИЛ”, and
61 available active branches. Its omission from main search is not explained by
being out of stock.

The live [category directory](https://pricecrab.mk/kategorii) exposed 17 grocery,
personal-care, pharmacy, household-cleaning and pet categories. Their displayed
counts summed to 57,388, close to the 57,420 headline. Non-food clothing was absent
from that directory. This supports a narrower public scope; without their code,
the exact homepage filter and the 32-product difference remain unverified.

Our available catalog includes clothing, toys, school supplies, books, seasonal
decorations, tobacco and other non-grocery goods. A deliberately broad keyword
scan of names and publisher categories flagged 13,216 entries. This is neither a
validated category count nor a deletion list: it can include false positives
such as sweets with toy gifts and miss other non-grocery products.

Do not assume PriceCrab's headline means explicitly in stock everywhere: public
product pages can include retailer offers whose availability is unknown, including
[the Gardenia peas example](https://pricecrab.mk/p/18714-gardenia-grashok-zamrznat-400-g).

## Store and branch scope

Eight chains overlap. We add Dim (6,260 available entries); PriceCrab adds Kipper
and Paket.mk. Excluding Dim leaves 125,717 available entries across the common
eight chains, still before cross-store merging or category filtering.

Our availability is the union across branches, not an individual branch's range.
For example, SPAR has 29,325 available chain identities but its largest available
branch has 15,370; Vero has 31,572 versus 18,858 in its largest available branch.
This explains why a chain total can look large. PriceCrab also exposes branch
availability, so this is not evidence that it imports only one branch.

Our current publications were imported on 25 October. PriceCrab is refreshing
on 26 October. These are not synchronized source snapshots.

## Recommended comparison and cleaning policy

Keep raw imports and unavailable/history records. Define and report separately:

1. Available store entries: one identity per chain, available in any active branch.
2. Available canonical products: one group across chains, with an available member.
3. Comparable available products: groups available in at least two different chains.
4. Public category scope: explicit included/excluded categories, independent of
   whether an item is available and independently visible in internal catalog views.

Evaluate matching on reviewed common-store examples before a full run. Measure
group-size distribution and matching accuracy, then compare counts using the same
categories, chains and source dates. Avoid deleting or broadly merging products
merely to make the headline resemble PriceCrab's.
