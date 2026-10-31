# Prepared cross-store matching

Matching works on unique chain products, using their saved categories. Physical branches retain separate offers. No import, categorization, matching campaign or paid evaluation is authorized by deployment.

## Flow

1. Capture the reviewed primary-product scope, categories, spending/request allowance and identity version. The default primary limit is 50. A rule-version change pauses an unfinished task for a newly reviewed task; it does not replay it silently.
2. Prepare source-supported identity facts in code. Matching-specific aliases and profiles are in `prompts/matching-identity.json`. Categorization freshness uses saved source snapshots and its own classifier prompts/model; matching preparation and brand dictionary edits do not invalidate saved categories. Actual provider payloads still use separate full-response caching.
3. Retrieve at most 20 candidate groups through barcode, full signatures, names, brands, amounts and categories. Reserve a strong result from each chain before filling remaining slots. Current groups are atomic and overlapping chain membership excludes a candidate group. AI comparisons use the task's saved category selection; code proofs remain available in all categories.
4. Reuse code facts and saved interpretations. Send plausible pairs to the Decider even when relevant identity facts are incomplete; supported size/pack/type conflicts and manual separations are filtered first. Each candidate gets its own same/different/insufficient question. Incomplete pairs also get a typed routing question about which source detail is useful, or whether the source never supplied it. A five-candidate request may contain ten billed questions. All questions share the task and global spending limits.
5. Only useful positive/uncertain responses can request Qwen. A missing-from-source route does not trigger interpretation. Prepare the primary and promising counterparts for the routed fields. Allocate extra counterpart slots when needed, rather than reserving them before decisions. Default: at most 50 additional counterpart products per task and five fresh counterparts per primary. Claims and consumption persist across restarts; cached facts require no new paid call.
6. Qwen returns literal source fragments in a strict schema containing only the requested fields. Code validates exact original quotes, field semantics, numeric amounts and units, then canonicalizes them. Generic descriptions cannot become containers. Unrecognized values remain uncertainty rather than false conflicts. Missing/invalid outcomes are remembered; manual corrections, including explicit unknowns, take precedence. A relevant changed fact can cause one Decider reconsideration; there is no interpretation loop.
7. Before any connection, apply product-specific evidence requirements. Water requires carbonation, drinks their named line/flavour, milk its fat/formulation, and other dairy its subtype details. One-sided packs, containers, multivitamin formulations, toast processing and flavours are never borrowed. The same-product threshold remains 75% by default; provider confidence is separate. Symmetric pair answers are cached by actual source/fact inputs, model and profile/prompt versions, independent of batch composition. Current thresholds reassess cached probabilities. A complete signature or validated barcode can provide a code proof.
8. Hold candidate groups competing for the same chain; clear compatible groups can still join. Every new relationship between group members needs a code or sufficiently probable AI proof. Existing groups are never split automatically. Complete identity maps, rather than incomplete brand/amount equality, establish genuine same-chain competition.
9. In a short transaction, recheck manual separations, availability, source/group versions, claims, all new relationship proofs and chain uniqueness. Save connections, redirects, membership history and detailed candidate decisions together. Provider calls never hold database transactions open.

## Results and operations

Run Tasks → matching tasks → **View results** shows connected/already-connected products, missing information, ambiguous chains, proven differences, absent candidates, deferred/stale work, source evidence and separate probability/confidence fields. Viewing results never makes AI calls. Results are saved with the task; older tasks are reconstructed read-only from decision history.

**Recheck unresolved products** creates a separately reviewed task containing only the earlier task's unresolved/deferred products. It retains that task's store/catalog scope and preserves earlier outcomes and spending. It does not sweep the general backlog.

Settings → Worker limits includes the default extra counterpart interpretation allowance and per-product limit. The run form can lower the task's counterpart allowance. Permission removal and lower live limits apply at safe checkpoints. Increasing saved settings cannot expand a reviewed task. Unavailable products remain excluded. Price updates and branch copies reuse matching memory.

The log adapters emit task/batch summaries, group outcomes and genuine failures. Pair reuse, preparation details, successful individual provider calls and candidate traces stay at debug level. The task result, rather than a stream of info logs, explains individual outcomes.

## Evaluation and activation

The failed 50-product snapshot in `.data/matching-investigation/2026-10-31/` is development data. The new source sampler is read-only and exports the compact available soft-drink/dairy catalog, 30 seeded untouched anchors per category, and an empty expected-outcome manifest. It excludes development products and recognizable development identity groups.

```bash
npm run matching:identity-sample
# Review and freeze expected same/different/insufficient pairs and 30 hard controls.
npm run matching:identity-evaluate -- path/to/dataset.json path/to/offline-report.json
# Only after implementation review and explicit approval:
npm run matching:identity-evaluate -- path/to/dataset.json path/to/paid-report.json --paid
```

The evaluation launcher uses a dedicated `_matching_test` database. It seeds saved categories locally and runs the real reviewed-task preparation/retrieval/decision/grouping workflow, rather than secretly calling categorization. Offline mode blocks all provider requests. Paid execution requires a frozen profile version, reviewed expected outcomes and the controls; its task allowance is capped by the required configuration value of $0.25. It never writes production categories or groups.

Report retrieval coverage, accepted-match precision/recall on reviewed positives, false joins, unreviewed connections, duration, requests and actual cost. Passing requires a sufficient sample, no false or unreviewed accepted connections, at least 95% retrieval coverage and at least 80% accepted-match recall on source-resolvable positives. Offline code-only results do not establish AI accuracy. Freeze the implementation before the untouched evaluation; report failures honestly rather than tuning against the holdout.

Production automatic matching remains controlled by the existing saved settings. Delivery does not activate it or launch a review/matching task.

## October 31 diagnostic benchmark

The initial 60-anchor paid evaluation retrieved all 86 expected pairs, but accepted only one expected connection. It used 105 Qwen requests and two Decider requests, costing $0.00419830. Missing brands and pre-decision evidence filtering explained most abstentions. Two additional joins lacked sufficient source evidence for distinguishing formulations. This is a failed development baseline, not an accuracy claim. The decision-led routing, literal extraction checks and formulation regressions address those failure modes. This delivery runs mocked checks only; a new untouched, source-reviewed paid evaluation is required before treating accuracy targets as met.
