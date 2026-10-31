# Brands

Brands are shared database records, separate from store products and shared product groups. A brand name alone never establishes that two products are the same.

In **Settings → Brands**, search the brand dictionary, add a brand, or edit its readable name and alternative spellings. A spelling can apply to every store or a selected store. Changes save immediately through the brand form, separately from automation settings, and are logged with the account making the change. A revision check prevents an older editor from overwriting a more recent change.

In **Products → All products**, use the Brand filter alongside store, availability, name quality, and matching filters. The selected brand is retained in the shareable URL. Product details display the shared readable brand name when one is connected. Unknown brands stay unknown.

The dictionary does not make provider requests. Existing categories, confirmed product connections, and their decision history are retained.

## Agent review with WebMCP

Open **Review → Brands**, sign in, and keep the page open in the agent's
WebMCP-capable browser. There is no agent-start button. Give the agent a bounded
instruction, for example:

> Use the brand WebMCP tools on this page to review 20 unresolved brand spelling
> groups. Reuse existing brands, save only aliases supported by exact source
> quotes, and skip uncertain cases. Do not start matching or make Gateway calls.

The agent discovers the current page tools, reads `get_brand_review_context`,
starts a bounded session with `start_brand_review`, and works through
`get_brand_review_batch`. It uses `search_brands` before saving evidence with
`submit_brand_review_batch`. Results, stop and conditional undo tools are also
available. Previously skipped unchanged groups are excluded by default.

Aliases normally apply to the quoted store; a global spelling needs evidence
from two stores. Saving a brand queues a bounded local fact refresh, preserves
saved categories and does not authorize matching. **Undo last batch** can undo an
eligible batch; **OK** hides session results without deleting saved work/history.
An external agent uses its own application/model allowance, not this app's
Gateway budget. A small common-brand pass is useful before another isolated
matching smoke test; a full-catalog pass is not required.

## Reference data and product evidence

Migration `040_brands.sql` seeds the reviewed dictionary once and links existing brand facts to stable brand IDs. It does not rerun categorization, alter prices, change product groups, or erase raw source text and decisions. Later migrations/startups never replace names or aliases edited through the application.

A brand's display name can change while its slug and product references stay stable. Renaming a display name preserves model input keys and existing category results. Alias changes apply to new products on future imports and deliberate product checks; unchanged imported products keep their saved facts; saving the dictionary does not sweep products or start paid work. Unknown brands are not guessed. The stable primary spelling is retained automatically.

Each product-task batch captures a dictionary snapshot. Brand facts retain their source quote and method; the relational `brand_id` mirrors that evidence. Name-only searches can expand aliases across stores, but fact extraction respects store-specific spellings. All brand writes are authenticated, checked for stale revisions and overlapping spellings, recorded in `brand_edits`, and sent through the logging adapters.

`reference-data/brands.json` is a frozen seed/test fixture, not the runtime dictionary. `reference-data/product-language.json` contains reviewed token aliases and ignored descriptors; character decoding and family-specific safety checks remain tested code.

## Deployment

Run the normal ordered migrations before starting the new web/worker build. Remove obsolete environment overrides for `matching.ai`, `matching.enabled`, `matching.automatic_enabled`, the retired per-store scheduler, and dictionaries previously embedded under `matching.local`. Startup rejects these settings rather than silently ignoring them. Use `.env.production.local.example` for the supported configuration. Saved Tasks permissions and budgets remain in PostgreSQL and are not reset.
