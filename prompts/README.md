# Product matching prompts

These are application-owned instructions, separate from original store text.
They are loaded and validated when the application or worker starts. Restart
local processes after an edit; rebuild Docker images to include changed files.

- `categories.json`: the shared decision labels and their definitions. `other`
  means identifiable but outside these categories; `unknown` means insufficient
  source information. IDs correspond to `families` in the matching domain.
- `classification.md`: category decision for every valid unique store product,
  including products whose original category looks clear.
- `matching.md`: common exact-product comparison instructions, sent once in the
  shared request state.
- `matching-question.md`: independent question template, using `{{candidate}}`.
- `matching-answers.json`: definitions of same, different and insufficient.
- `clarification.md`: Qwen's source-only extraction instructions.
- `stores/*.md`: conventions and limitations of each chain's source names.
- `families/*.md`: comparison guidance specific to a product category.

`matching.prompts` in configuration lists every required file explicitly. Files
must be nonempty and remain inside the configured root. Missing/invalid files
fail startup; there is no silent generic-prompt fallback. Only relevant store
and category guidance enters a request. Supporting quotes always refer to the
original source, not a prompt, normalized name or another store's product.

Every actual bundle has a content hash. Its original files are retained in
`matching_prompt_versions`; classifications, AI usage and matching decisions
reference that hash. Editing a cleaning prompt does not invalidate dairy or
classification requests. Existing saved connections and history are never reset
by a prompt edit. Changed prompts apply when relevant work is processed; this
feature does not launch a catalog-wide reevaluation automatically.

Selecting categories for AI matching is a separate configuration decision:
`matching.ai_categories` / `NEXTSIGNAL_MATCHING__AI_CATEGORIES` (JSON array).
The list is intentionally empty until the owner chooses the labels. No labels
means classification plus code-only matching, not permission to compare all
categories. Code-based matching remains available for every category, subject
to saved manual separations and complete-group checks.

`matching-identity.json` defines versioned matching-only product profiles and reviewed type/flavour/formulation aliases. It is archived with comparison and clarification prompts, and does not participate in classification prompt keys.
