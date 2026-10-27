# Category review

Open **Review** in the sidebar. It uses saved classification results and
never starts a classification or matching campaign.

- **Needs review** shows products whose model answer did not assign a category.
- **Decision model** lets a person check categories accepted automatically.
- **Agent** shows saved connected-agent choices; **Human** shows human choices.
  **All labeled** combines these lists.
- Store and name filters apply to counts and results. Only currently available
  products appear initially. **Include unavailable** also includes other products
  still listed by an active catalog. Removed products retain their history.
- Choose a category or accept the suggestion to save and move to the next product.
  **Skip** leaves the product unchanged. **Undo** restores the previous manual
  override (or returns to the saved AI answer), with another audit entry.
- **Enter** accepts a suggestion, **1–9** selects a ranked category, and **N** skips.
  Shortcuts are ignored in text fields, selectors, and product-detail dialogs.

The small check button beside an uncertain suggestion in product details and
categorization task results uses the same authenticated save operation. Historical
results can only offer quick approval when they refer to the current saved answer.

## Saved scores and safe changes

`store_product_classifications.probabilities` already contains per-label scores.
`classificationViews` projects these scores into the shared product classification
view. All configured labels are returned, highest score first, with stable ordering
for ties. Missing or invalid scores display **No score**, not a fabricated zero.
The selected-label probability remains separate from Gateway confidence. These
scores describe the model's answer; they are not measured accuracy percentages.

`GET /api/review/categories` reads one page and scoped counts in a read-only
transaction. It queries unique store products, so branch copies do not create
repeated review entries. It neither calls providers nor creates tasks.

Choices use the existing `PATCH /api/products/[id]/category` process and repository.
The reviewed snapshot is checked under the existing product/group locks. Stale
screens cannot overwrite newer source data or another person's choice. The response
includes the resulting snapshot from the same transaction, so Undo is protected by
the same check. The original model response, category history, and source names are
preserved. Existing automation permissions continue to govern any follow-up work;
reviewing products does not enable those permissions.

Each changed category creates a `product_category_edits` record containing the
account, time, action, before/after category, original classification reference, and
optional note. The existing log adapter emits `products.category.updated`,
`products.category.rejected`, or `products.category.failed` as appropriate. Queue
reads are debug-level events rather than extra information-level progress logs.

The UI lives in `app/_components/dashboard/category-review.tsx`. Queue reads live in
`nextsignal/services/category-review.ts`, label ranking in
`nextsignal/domain/category-scores.ts`, and existing saves/audit history in
`nextsignal/services/product-categories.ts`. Migration 036 adds agent provenance and review sessions; no provider call is
required to review already classified products.

See [Agent category review](agent-category-review.md) for the WebMCP workflow.
There is no start button: ask the connected agent to review a bounded number of
products. The panel shows progress and saved results, and provides Stop and Undo.
