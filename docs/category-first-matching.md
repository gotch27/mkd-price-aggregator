# Categories and matching eligibility

Categorization and matching are separate authorized tasks. The saved deployment settings, rather than this document, determine whether automation is enabled.

- Categorization reads source names/descriptions/categories and saves the Decider result and label probabilities. Initial acceptance is 80%; uncertain labels remain in Review for Human, Agent or internal LLM review.
- Matching never categorizes extra products to fill a task. AI-assisted tasks select only saved categories chosen in that run. Automatic matching uses its separately saved category list.
- Code proofs apply in all categories. Categories guide retrieval and paid eligibility; category disagreement alone is not proof that products differ.
- Price changes and extra branches reuse categories and matches. Unavailable products stay outside both tasks. An unchanged returning product reuses its saved information.
- Source text is normalized for reading while original names and exact evidence quotes are retained.

The current matching flow prepares both sides, applies product-specific identity profiles, caches symmetric pair decisions and validates complete groups. See [Prepared cross-store matching](matching-identity.md) for limits, task results, evaluation and activation.

External prompt/profile versions are archived with decisions. Matching profile changes do not invalidate category input keys or authorize a full reclassification.
