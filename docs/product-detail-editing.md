# Editing store product details

Open Products → Details → Store products → **Edit details** on a store card.
The form edits brand, product type, amount/unit, pack count, variant, packaging,
barcode and additional distinguishing facts. **Edit history** shows who changed
each value, when, its before/after values and an optional reason. No JSON is shown.

Corrections apply to one unique product in one chain, across its branch copies.
Original names, descriptions and price observations are kept. Repeat imports and
price changes preserve corrections. A genuinely changed source description creates
another revision; corrections are not copied blindly onto a different product.
Saved corrections and edit history remain attached to the previous revision.

Clearing a field explicitly marks it unknown. Rules and model clarification cannot
fill that field again. **Restore store details** removes the manual overrides and
uses supported source facts again; this action is also retained in history.
Amounts and units are saved together, with kg/l converted to g/ml. Barcodes require
a valid check digit, pack counts must be positive integers, and percentages stay
between 0 and 100. Values and notes have explicit configured length limits.

## Persistence and matching

Migration `019_manual_product_details.sql` adds `store_products.manual_facts` and
the append-only `product_detail_edits` table. Source observations are not rewritten.
The audit record and effective fact update commit in one transaction. Human facts
have `method=manual` and `source=manual`; they are distinct from source quotes and
Qwen extraction. Authentication supplies the author; callers cannot choose it.

An edit preserves saved connections. If supported facts now conflict in a group,
the group is flagged for review rather than silently split. Correcting/restoring
the facts can clear that flag. Saves invalidate stale in-flight claims and queue
only the affected store product for a future matching check. **Saving does not call
AI or start a matching campaign.** Automatic matching and Gateway access retain
their separate disabled configuration until activation is explicitly approved.

The editor also works for an unmapped legacy browser entry. It prepares only that
product and its bounded branch aliases, using the same helper as manual matching.
It refuses oversized/conflicting legacy cases rather than launch a full backfill.

## Code and API

- `nextsignal/domain/product-edits.ts`: client-safe field definitions and types.
- `nextsignal/domain/product-edit-validation.ts`: human-input validation.
- `nextsignal/services/product-details.ts`: editable view, transactions and audit.
- `nextsignal/services/store-product-groups.ts`: shared group snapshots and bounded
  legacy preparation used by product editing and manual matching.
- `app/api/products/[id]/attributes/route.ts`: thin GET/PATCH transport.
- `nextsignal/processes/api/operations.ts`: authorization, strict input schemas and
  logger context; `products.editableDetails` and `products.updateDetails` processes.
- `app/_components/dashboard/product-details-editor.tsx`: shadcn form/history dialog.

Both API methods require a signed-in user. Writes reject untrusted origins, unknown
fields, forged author fields and stale snapshots. The API cannot edit price or
source identifiers. Configuration lives in `product_details` and the root
`NEXTSIGNAL_PRODUCT_DETAILS` override: value/note length limits and recent-history
display limit. The display limit does not delete older audit records.

Successful writes use the existing log adapter at info level with event
`products.details.updated`, author, store/product IDs and changed values. Rejected
edits log `products.details.rejected` at warn; unexpected failures log
`products.details.failed` at error. No-op submissions log debug. Notes remain in
the audit history rather than operational logs. Success is logged only after
commit; a failed save cannot leave a successful edit or a partial audit record.

Isolated tests cover persistence, reset/unknown values, exact unit conversion,
source preservation, group conflicts, concurrent/stale saves, rollback, bounded
legacy preparation, provider cache inputs, authentication, validation and logging.
They make no live model calls.

The full suite passes 207 tests; type checking, production Docker builds and the
HTTP smoke checks pass. Migrations 018/019 and the web update are applied locally.
The worker remains stopped, automatic matching/Gateway calls remain disabled, and
the AI category selection remains empty. Visual browser verification was blocked
by the browser permission gate; no production product values were edited for QA.
