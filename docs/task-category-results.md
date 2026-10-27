# Categorization results

In **Tasks → Run tasks → Task activity**, each categorization task has a
**View results** button, including running, paused and completed tasks. The panel
shows the selected product names, store categories, saved AI categories, the
model's selected-category probability, the required threshold and uncertainty.
Search, category/result filters and pagination operate within that task. Product
names open the existing product details. Viewing results never calls AI.

An accepted category is **Assigned**. Answers kept as `unknown` are **Needs
review**, with the suggested category and its probability preserved. A checked
item without a valid saved answer is also **Needs review**, with its reason.
Selected work not processed yet is **Waiting**. Probability remains separate
from the provider's reported confidence; it is not a measured accuracy score.

`task_items.result` is an immutable product/result snapshot, written with the
item's completion and task progress transaction. It includes the classification
record, threshold, model and prompt hash. Later product edits, new categories,
cached reuse and redirects do not replace the result of an earlier task.

Migration 031 recovers existing completed results only when a successful Gateway
generation is owned by that exact task. It reuses paid decisions and performs no
classification, import or provider request. No new legacy/preparation UI exists.

The authenticated read endpoint is:

```text
GET /api/tasks/<id>/results?page=1&size=30&search=&category=&outcome=
```

The route remains thin. The API process owns authorization and filter validation;
`nextsignal/services/task-results.ts` owns snapshots and scoped reads. Reviewing
results does not call AI. Manual category controls are described below.

## Logging

Successful Gateway request-start/completion milestones use **debug**. Provider
errors, rejected/uncertain billing and budget warnings retain their existing
severity. Full usage/cost records and classification history remain durable.

At info level, product tasks log batch start and completion, the number assigned,
items needing review, task progress, elapsed time, total spending and requests.
Large tasks still have one checkpoint per bounded batch, rather than two normal
log entries per paid call. Existing logs are not deleted or rewritten.

Isolated tests cover immutable snapshots, low-probability answers, cached reuse,
history recovery, pagination, literal/search/category/result filters, missing
tasks, route authentication, stale inputs, quiet info logging, preserved billing
and visible provider failures. Providers are mocked for verification.

## Deployment verification — 25 October 2026

All 437 isolated tests passed; strict type checking and the production Docker
build passed. Authenticated production reads verified the original KAM task's
50 immutable snapshots: 34 assigned, 16 needing review, no waiting items. Paging
returned 30 then 20 distinct products. Uncertainty/category/search filters and
product-detail links passed; unauthenticated access was rejected. Public HTTPS
and container health passed. Provider requests stayed at 50, classification
records at 50, and task count at 3. Saved permissions were unchanged. No paid
request or new task was started during delivery.

## Product details

Each store-product card now displays **AI category** immediately below its name.
Assigned categories show the selected-category probability. Unknown results show
**Needs review**, the suggested category, probability and required threshold.
Unprocessed products show **Not categorized**. If the current product information
or categorization instructions no longer match the saved decision, the card shows
**Needs recategorization** and retains the previous category for reference.

The detail API reads the saved classification matching the product's input key
and recorded threshold, including for products no longer offered. Each store
keeps its own classification in a shared group. Reading details does not call AI,
reclassify products, or overwrite the immutable task results.

## Manual categories and suggestion approval

Use **Change category** below a store product's name, or **Review category** in
the task results. Choose a category and save, or use **Accept suggestion** for a
current model suggestion below the acceptance threshold. Approval applies to that
one store product; it does not lower the global threshold or claim that the
model's probability was higher. A manual choice displays **Manually confirmed**.

Manual choices survive price imports, branch copies, detail corrections and
later AI runs. A genuinely different product revision starts with its own
category. **Remove manual choice** returns to the current saved model answer;
if that answer is outdated, the product waits for deliberate categorization.
The category editor itself makes no provider call. Subsequent matching obeys
the saved automation permissions.

Migration 032 adds `store_products.manual_family` and the durable
`product_category_edits` audit. Every change records the account, time, action,
before/after values, linked model answer and optional note. History is available
inside the editor; changes also use the existing log adapters. Stale edits and
stale suggestions are rejected, and in-flight AI answers cannot overwrite a
human choice. Removing a manual choice retains its history.

Task results preserve the original answer and probability, with the current
manual category shown separately. **Needs review** excludes uncertain items
already manually confirmed; **Reviewed** finds those items. Category filters and
counts use the current category, without rewriting the original task snapshot.

The authenticated endpoints are `GET /api/products/<group>/category?member_id=…`
and `PATCH /api/products/<group>/category`. The latter requires the current
snapshot, a typed action and an allowed category; it rejects foreign-origin
writes. Category permissions do not depend on AI being enabled.

The 450-test isolated suite covers manual assignment, uncertain-suggestion
approval, import persistence, stale edits, late AI responses, reset, revision
boundaries, duplicate consolidation, authentication and immutable task results.
Provider calls are mocked; no live category edit or paid test is needed to
verify the implementation.

### Manual review deployment verification — 25 October 2026

Strict type checking and the production Docker build passed. All 450 isolated
tests passed, followed by the 8 focused category-edit tests after the final
current-category filter change. Migration 032 was applied on the homelab.
Authenticated production reads verified assigned and uncertain product labels,
the category picker data, unauthenticated rejection and approval eligibility for
KAM's `ГРЕБЛО ЗА МРАЗ` suggestion (`automotive`, 76.22%, below the 80% threshold).
No real suggestion was approved during verification. All containers and public
HTTPS health were healthy. Requests remained 50, classifications 50, tasks 3,
manual category edits 0, and settings revision 6 with the exact saved policy.
