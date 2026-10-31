# Prepared cross-store matching

Matching works on unique chain products, using their saved categories. Physical branches retain separate offers. No import, categorization, matching campaign or paid evaluation is authorized by deployment.

## Flow

1. Capture the reviewed primary-product scope, categories, spending/request allowance and identity version. The default primary limit is 50. A rule-version change pauses an unfinished task for a newly reviewed task; it does not replay it silently.
2. Prepare source-supported identity facts in code. Matching-specific aliases and profiles are in `prompts/matching-identity.json`. Categorization continues using its existing request construction; matching preparation does not change category freshness.
3. Retrieve at most 20 candidate groups through barcode, full signatures, names, brands, amounts and categories. Reserve a strong result from each chain before filling remaining slots. Current groups are atomic and overlapping chain membership excludes a candidate group. AI comparisons use the task's saved category selection; code proofs remain available in all categories.
4. Plan optional counterpart interpretations across the selected batch, ordered by retrieval rank, shared relevance and stable product IDs. Default: at most 50 additional counterpart products per task and five fresh counterpart interpretations per primary product. Preparation slots and their consumption persist across checkpoints/restarts. All interpretation and comparison calls share the task and global spending/request limits; there is no separate free allowance.
5. Reuse code facts and saved interpretations. When needed and permitted, Qwen interprets relevant supplied text on either side. Its strict schema allows only requested fields. Exact original quotes, allowed fields, units and numeric evidence are checked before canonicalization. Missing or invalid information is saved as an abstention; repeat comparisons do not keep paying for the same unsuccessful interpretation. Manual corrections, including explicit unknowns, take precedence.
6. Apply product-specific evidence requirements. Water requires carbonation, juice/drinks require their named line/flavour/formulation, milk needs fat information, and other dairy uses subtype-specific details. One-sided pack, container, fat, formulation and flavour facts are never borrowed. Unsupported types remain unrecognized, not contradictory. A complete exact-name signature or validated barcode can provide a stronger code proof.
7. Compare only pairs that could be accepted. Decider questions remain same/different/insufficient, in batches up to five. The same-product threshold remains 75% by default. Provider confidence is independent. Pair answers are keyed symmetrically by source/fact inputs, model and profile/prompt versions, independent of batch and group composition. Updated acceptance settings recheck cached probabilities.
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
