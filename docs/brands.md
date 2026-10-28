# Brands

Brands are shared database records, separate from store products and shared product groups. A brand name alone never establishes that two products are the same.

In **Settings → Brands**, search the brand dictionary, add a brand, or edit its readable name and alternative spellings. A spelling can apply to every store or a selected store. Changes save immediately through the brand form, separately from automation settings, and are logged with the account making the change. A revision check prevents an older editor from overwriting a more recent change.

In **Products → All products**, use the Brand filter alongside store, availability, name quality, and matching filters. The selected brand is retained in the shareable URL. Product details display the shared readable brand name when one is connected. Unknown brands stay unknown.

The dictionary does not make provider requests. Existing categories, confirmed product connections, and their decision history are retained.

## Reference data and product evidence

Migration `040_brands.sql` seeds the reviewed dictionary once and links existing brand facts to stable brand IDs. It does not rerun categorization, alter prices, change product groups, or erase raw source text and decisions. Later migrations/startups never replace names or aliases edited through the application.

A brand's display name can change while its slug and product references stay stable. Renaming a display name preserves model input keys and existing category results. Alias changes apply to new products on future imports and deliberate product checks; unchanged imported products keep their saved facts; saving the dictionary does not sweep products or start paid work. Unknown brands are not guessed. The stable primary spelling is retained automatically.

Each product-task batch captures a dictionary snapshot. Brand facts retain their source quote and method; the relational `brand_id` mirrors that evidence. Name-only searches can expand aliases across stores, but fact extraction respects store-specific spellings. All brand writes are authenticated, checked for stale revisions and overlapping spellings, recorded in `brand_edits`, and sent through the logging adapters.

`reference-data/brands.json` is a frozen seed/test fixture, not the runtime dictionary. `reference-data/product-language.json` contains reviewed token aliases and ignored descriptors; character decoding and family-specific safety checks remain tested code.

## Deployment

Run the normal ordered migrations before starting the new web/worker build. Remove obsolete environment overrides for `matching.ai`, `matching.enabled`, `matching.automatic_enabled`, the retired per-store scheduler, and dictionaries previously embedded under `matching.local`. Startup rejects these settings rather than silently ignoring them. Use `.env.production.local.example` for the supported configuration. Saved Tasks permissions and budgets remain in PostgreSQL and are not reset.
