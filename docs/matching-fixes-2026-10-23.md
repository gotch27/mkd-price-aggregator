# Matching fixes and independent check — 23 October 2026

**The requested normalization and validation fixes are implemented, but matching is still not ready for a production campaign.** The development examples improved substantially. A new independent sample found that coverage outside the reviewed brands and product types remains inadequate.

## Results

| Measure | Original test | Final fixes: same development examples | Independent sample |
| --- | ---: | ---: | ---: |
| Store products | 73 | 73 | 76 |
| Reviewed comparisons | 109 | 109 | 64 |
| Expected same-product pair connections | 101 | 101 | 13 |
| Expected pair connections formed | 17 | **75** | **0** |
| Expected pairs still unresolved | 84 | 26 | 13 |
| Complete expected groups | 0 / 20 | **12 / 20** | **0 / 6** |
| Incorrect connections in reviewed cases | 0 | 0 | 0 |
| Additional unreviewed connections | 0 | 0 | 0 |
| Positive pairs found by initial candidate retrieval | 99 / 101 | 101 / 101 | 13 / 13 |
| Paid requests | 261 | 55 | 256 |
| Provider-reported charge | $0.00985073 | **$0.00258298** | **$0.00796910** |

The final development run contains eight accepted AI comparison proposals; the other connections use the supported exact-signature rules. Pair relationships, comparison proposals and complete groups are different counts. No result here establishes a general catalog accuracy percentage. No wrong joins in a test which accepts nothing is not evidence of useful matching.

## What changed

- Reviewed brand spellings now share comparable values while original names and quotes remain intact. Nutella/Nutela/НУТЕЛА are one brand; standalone Bambi is not silently turned into Plazma.
- Product type, range, flavour/fragrance, whole/ground processing and cosmetic shade are separate fields. Creme Care and Creme Soft remain distinct; Fairy apple is recognized as a cleaning product.
- Code reads more explicit store formats. It preserves unfamiliar words and model codes in exact signatures. Complete phrases normalize before shorter overlapping aliases, and repeated unknown words stay significant (Mini versus Mini Mini).
- Clarification validates facts independently: an invented model no longer discards a separately supported brand. Amount and unit still pass or fail together, with exact decimal conversion.
- Queued products and candidate/group checks use consistent current rules. There is no database-wide reset or automatic reprocessing campaign.
- Saved comparisons and adapter logs explain missing facts, explicit differences and the actual probability threshold. Rejected clarification fields and retained fields are logged separately.
- The evaluator now records complete-group counts, actual final facts/groups, provider usage and final work state in addition to pair outcomes.

Matching probability remains **0.99**. The models remain Perplexity Decider V1.2 and Qwen3.7 Flash. Final tested language rules were cross-store-v4 / exact-names-v3 with prompt cross-store-v3.

## Remaining development misses

26 expected pair relationships remain unresolved. Examples include a missing container (a Nutella jar or Happy Day carton named by only one store), unmodeled wording that prevents an exact signature, and otherwise positive AI answers below 0.99. Omitted container or pack details are not filled by guessing.

| Expected group | Actual groups, separated by / | Complete |
| --- | --- | --- |
| 1. Coca-Cola regular, single 330 ml can | kam + spar + reptil + ramstore + vero + dim + zur | Yes |
| 2. Coca-Cola Zero, single 330 ml can | reptil / spar + ramstore + vero + zur | No |
| 3. Coca-Cola regular, 6 × 330 ml cans | kam + reptil + spar / zito | No |
| 4. Nutella spread, 400 g | kam + reptil + vero / spar | No |
| 5. Nutella spread, 750 g | stokomak / ramstore / reptil + zito | No |
| 6. Plazma regular whole biscuits, 300 g | ramstore + reptil + vero / zito | No |
| 7. Plazma ground biscuits, 300 g | kam + stokomak + reptil + vero | Yes |
| 8. Plazma Mini Mini biscuits, 200 g | kam + reptil + vero + zito | Yes |
| 9. Nescafé Classic, 200 g tin | ramstore + spar + zito / vero | No |
| 10. Nescafé Classic, 150 g refill bag | stokomak / spar + ramstore + zur | No |
| 11. Nivea Creme Care shower gel, 250 ml | ramstore + vero + zur | Yes |
| 12. Nivea Creme Soft shower gel, 250 ml | spar + vero + zur | Yes |
| 13. Fairy lemon washing-up liquid, 450 ml | vero + zito + zur | Yes |
| 14. Fairy apple washing-up liquid, 900 ml | reptil + vero + zito | Yes |
| 15. Fairy Max Power lemon washing-up liquid, 545 ml | reptil + zur | Yes |
| 16. Happy Day Family blueberry drink, 1 L | ramstore + vero / zur | No |
| 17. Vincini orange medenjaci, 150 g | ramstore + spar + zur | Yes |
| 18. Bio Zen organic soy drink, 1 L | dim + zur | Yes |
| 19. Garden Extra cornichons, 6–9 cm, 720 g | dim + zur | Yes |
| 20. Malena Pink pencil, shade/model 707 | zito + spar | Yes |

## Independent sample: why it matters

The independent fixture uses **18 seeded random anchors, two per chain**, and up to five suggested counterparts per anchor. All nine chains are represented. Exact duplicate source names within a chain are represented once for this text diagnostic; this does not test production branch-identity deduplication. Constructed controls are excluded. There is no overlap with the 20 development product groups. Source names, descriptions and categories were reviewed and labels fixed before provider output. Rules were not tuned after seeing this result.

The source review identifies **13 same-product pairs in six groups, 30 explicit differences and 21 insufficient-information cases**. All 51 difference/uncertainty cases stayed separate. All 13 known positive pairs also stayed separate, even though retrieval found them.

Concrete positives that were missed include identical Dr Benner strawberry granola 40 g names, Kosili pink bath product 200 ml, Stark Na Pola Tanke cocoa/vanilla wafers 130 g, HIT Mini chicken/rice dog food 500 g, and Vocna Dolina apricot/apple drink 1.5 litres. The full original names and label reasoning are in [the independent review](matching-independent-review-2026-10-23.md).

Observed blockers:

1. **Brand/type coverage is too narrow.** An unfamiliar brand cannot use the reviewed exact-signature path. Many literal product types returned by Qwen are outside the reviewed type vocabulary, so they cannot establish identity.
2. **Ingredient words can still misclassify prepared products.** Vocna Dolina apple drinks were treated as fruit, and rice in dog food became the product type. The Fairy-specific correction does not solve this general category problem.
3. **Source interpretation remains inconsistent.** Obvious products can retain an unknown category or fail literal source validation. Source omissions such as diaper size and product range still require abstention.
4. **The fixed 0.99 threshold still limits recall.** Its suitability needs calibration on independently reviewed examples after broadening supported facts. Simply lowering it would not resolve missing or incorrectly interpreted facts.

The next work should address product-type/brand coverage and category precedence across families, then evaluate on another untouched group-level sample. These independent examples can now become development regressions; they must not be presented as untouched evaluation again after tuning to them. The agreed 90-anchor review plus difficult controls remains outstanding before activation.

## Spend and operational checks

There were two bounded development reruns while finishing the fixes, followed by the independent test. The first intermediate rerun formed 73 / 101 pairs and 11 / 20 groups. The combined charge for this round is **$0.01318876** (about 1.32 US cents), below the promised $0.25 allowance. Including the earlier baseline test, cumulative reported charge is $0.02303949.

| Run | Model | Paid requests | Input tokens | Output tokens | Reported charge |
| --- | --- | ---: | ---: | ---: | ---: |
| First fixes | perplexity/pplx-decider-v1.2 | 59 | 131834 | 134 | $0.002636680000 |
| Final fixes | perplexity/pplx-decider-v1.2 | 55 | 129149 | 132 | $0.002582980000 |
| Independent sample | alibaba/qwen3.7-flash | 62 | 40717 | 12223 | $0.002810500000 |
| Independent sample | perplexity/pplx-decider-v1.2 | 194 | 257930 | 428 | $0.005158600000 |

All usage records in these completed runs have successful provider-reported billing. No uncertain reservations remain. All 73 development and 76 independent work items finished; the independent harness deliberately exits with failure because it formed no useful positive connections. This is an evaluation failure, not a transport failure or a skipped test.

Automated verification: **159 tests across nine files passed**, TypeScript check passed, production build passed, and Git whitespace checks passed. New tests cover normalization, range/processing/shade conflicts, unknown suffix preservation, partial clarification validation, amount/unit coupling and adapter logs for rejected fields and threshold failures. No UI behavior changed in this fix pass, so no application server was started for browser checks.

Production automatic matching and Gateway flags were verified **false**. A read-only check confirmed migration 016 is still absent from the application database. No application migration, full import, backfill, worker or production campaign was started.

## Reproducible artifacts

- Development fixture: tests/fixtures/real-store-matching-evaluation.json
- Independent fixture: tests/fixtures/independent-store-matching-evaluation.json
- Final development result: .data/matching-evaluation/vercel-fixed-final-2026-10-23.json
- Independent result: .data/matching-evaluation/vercel-independent-2026-10-23.json
- Original baseline report: [matching-evaluation-2026-10-23.md](matching-evaluation-2026-10-23.md)

The JSON artifacts contain machine-readable facts, decisions and usage. Read the Markdown reports for a plain-language review.
