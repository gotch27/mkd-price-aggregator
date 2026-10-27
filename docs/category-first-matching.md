# Category-first matching

Automatic matching and Gateway calls remain disabled. The AI category list is
intentionally empty pending the owner's label selection. No production matching
campaign, import, classification pass or full backfill was run for this change.

## Flow

1. Publication retains one durable product per chain/article/descriptive revision;
   branches attach observations and prices to that product. Existing connections,
   IDs, source observations and manual corrections remain intact.
2. Conflicting or ambiguous source identities are parked before using models.
3. Every valid waiting product is classified by the configured Decider, including
   products that code already recognizes. Pass original/readable name, useful
   description, original category and deterministic source facts, without prices,
   branch IDs or retrieval metadata. A normalized unchanged revision reuses its
   saved category. The rules' category is only a hint, not the model's answer.
4. Try indexed validated-barcode/exact-signature matches in all categories.
   Respect saved manual separations, supported-fact conflicts and group safety.
5. Only selected categories enter AI comparison. Candidate filtering occurs
   before the candidate limit; candidates' existing active members must also
   have a selected saved category. An excluded item cannot consume a comparison
   or Qwen call. Exclusion is not evidence that products differ.
6. Compare at most 20 groups in batches of five independent choice questions.
   Shared instructions and unique product records are sent once; group members
   reference those records. Multiple candidates can match in the same batch.
7. Accept a same-product proposal at probability >= 0.75 only with sufficient
   source facts and a compatible complete group. The API confidence field is
   stored separately and does not substitute for the probability. Category
   acceptance retains its separate configured 0.80 threshold.
8. Qwen may interpret a useful detail actually present in the selected product's
   source text once, followed by one reconsideration. Literal quotes and allowed
   fields are validated. Unprovided information is never invented.
9. Save the connection, reason or category exclusion. Each group retains at most
   one distinct product from each chain; all branch prices remain attached.

## Persistence and configuration

Migration `018_category_first_matching.sql` is additive. It adds saved category
metadata, append-only classification decisions, prompt-source snapshots and
prompt/operation references in provider usage and match decisions. It changes
no existing connection and launches no work. `category_excluded` is a separate
unmatched state with a readable reason, not a permanent negative pair decision.

`matching.ai_categories` is an explicit required array of predefined IDs. Both
root env examples and defaults start with `[]`. Root `.env.local` overrides JSON
configuration. Changing the selection does not invalidate saved classification
answers. The background queue reconciles newly enabled excluded products in
bounded chunks, scoped when requested; it does not reset completed connections.
It also discovers useful new neighbors through the existing deduplicated events.
Products completed by the previous workflow, including manual connections, are
queued in bounded chunks for their first category only when Gateway is enabled.
Their existing connections are preserved. No full table reset is used.

Model category answers are tied to their actual source inputs and prompt bundle,
not the selected-label list or matching cutoff. An updated category threshold can
reuse the provider response. Classification metadata is saved with version checks;
stale answers remain in history and cannot alter current product facts or groups.
A model category takes precedence over heuristic category guesses during reads.

See [../prompts/README.md](../prompts/README.md) for the external instruction files.
Only relevant store/family guides are composed. Required prompt files are validated
at startup and copied/traced into standalone Docker deployments. Prompt source
snapshots are retained by hash so decisions remain explainable after file edits.

## Logs and tests

The existing log adapters carry run, work, product, campaign and request context.
New events include `matching.classification.saved`, `.stale`, `.reused`,
`.queued`, `matching.category.excluded` and `matching.categories.requeued`. Existing provider
logs retain request identity, operation, prompt hash, tokens, cost and cache hits.
No source prompt text or credentials are printed to ordinary operational logs.
Product-level traces use debug; queue changes and usage use info.

The test launcher supplies a dummy Gateway key. Mocked native responses exercise
classification, comparison, source-only clarification, caching and budget handling
on the isolated test database. Tests cover 0.74/0.75 probability boundaries,
independent confidence, excluded/unknown categories, free matches, label changes,
branch/price reuse, conflicting details, prompt versions and manual history.

For a deliberately small evaluation after selecting its categories:

```sh
npm run matching:evaluate -- --categories=soft_drinks,dairy
# Add --paid only for an explicitly agreed live evaluation.
```

The category override applies only to the disposable evaluation process, not the
application env file. Reports include selected labels, category counts and token/
spending totals per operation. These tests do not establish real-world accuracy
at the new 75% threshold; a reviewed live dataset is still required before activation.

## Verification and review state

The category-first isolated suite passed 192 tests, including a fresh application of
migration 018. Type checking, the production Docker builds and HTTP smoke checks
against a temporary web container using the isolated database passed. The host
Turbopack build was blocked by local port permissions; the Docker production
build completed. Browser permission for the temporary test address was denied,
so visual browser verification remains incomplete.

The temporary container was removed. The later [manual detail editor](product-detail-editing.md)
delivery applied schema migrations 018/019 and updated the main web container;
the worker remains stopped. No live Vercel requests were made. Automatic matching
and Gateway access remain off and the AI label list remains empty. Review the code
and choose AI labels before considering any matching activation.
