# Agent category review through WebMCP

Open **Review** while signed in, then ask a connected browser agent:

> Review 50 products needing categorization. Save clear choices and skip unclear ones.

There is no activation or start button. Opening the page only registers tools and
reads progress. It never starts a session, calls Vercel, or starts a worker task.
The browser must support WebMCP. Without it, the normal human review UI still works.

## Tools

- `get_category_review_context`: definitions, instructions, current page filters,
  configured limits and latest session.
- `start_category_review`: a deliberately requested, fixed list of available
  products needing review. Default 50 products; maximum 500. Store/search filters
  default to the visible page; `retailer: "all"` explicitly selects all stores.
  Previously skipped products are excluded by default while their source name,
  description, store category, supported facts and saved classification are
  unchanged. This includes skips saved before this behavior was added, across
  all agent sessions/accounts. Set `include_previously_skipped: true` only for a
  user-requested retry; the effective selection is saved with the session and
  included in its start log. An empty selection completes with zero products;
  it never fills the session with earlier skips automatically.
- `get_category_review_batch`: up to 20 unfinished products, readable and original
  source text, supported facts, store guidance and original decision-model scores.
- `submit_category_review_batch`: immediate Agent choices or skips, each with the
  exact member ID, snapshot and a reason. Use the same UUID `request_id` and exact
  decisions to retry an interrupted call safely.
- `get_category_review_results`: inspect saved choices, skipped/rejected products
  and progress.
- `stop_category_review`: keep completed changes and block later submissions.

Read context first. Starting a session requires an instruction from the user; tools
must not start further sessions to exhaust a backlog. Only one active session per
account is allowed. No provider key or application AI permission is needed. The
connected agent's own model/runtime is separate from the application's Gateway.

Instructions are in `prompts/agent-category-review.md`. Category definitions and
store conventions reuse the existing external prompt files. These files are
included in tool responses; editing agent guidance does not invalidate decision-
model classifications. Limits are explicit `agent_review` configuration values,
loaded through the normal NextSignal configuration providers.

## Saved provenance and safety

Current categories distinguish **Decision model**, **Agent**, and **Human**.
Human confirmation of an agent category changes its source to Human, even if the
category value stays the same. Original model answers and probabilities remain
available. No synthetic agent probability is displayed. Agent name/model fields
are self-reported metadata, not a verified identity.

The existing durable category override (`manual_family`) now supports Human and
Agent provenance. Retaining this shared storage also keeps existing import and
classification guards effective: neither a repeat import nor a later model answer
replaces a reviewed category. Historical human choices are preserved by migration
036, including their previous actor, time and note where recorded.

Session membership is fixed at creation. Scope cannot expand during pagination,
retries or reloads. Skips and rejected/stale items count as processed in that
session; skipped products remain in Needs review for human review or an explicit
agent retry. Price-only changes, added branch copies, session dismissal, and
restarts do not clear the saved skips. New source information or a new saved
classification can make them eligible again. Rejected items and unfinished items
in stopped sessions are eligible again, because neither is a confirmed skip.
Products already assigned by the model, human/agent choices, uncategorized products
and unavailable products are outside the initial session selection.

Batch submissions serialize with existing product/group commits and the session
row. Each product gets a savepoint so expected conflicts do not prevent other
valid choices from saving. The bounded batch and its idempotency result commit in
one transaction; unexpected failures roll it back. No database transaction stays
open while the agent reasons. Repeated request IDs with different inputs are
rejected. A Stop may wait for the already-running transaction to finish.

The UI shows progress and paginated results, plus Stop and **Undo last batch**.
After a session finishes or is stopped, **OK** hides its results, status, progress
and Undo control, leaving the Agent review availability message. This dismissal is
saved for the account and survives refreshes. It does not change categories,
delete history, or affect a newer session. New agent reviews appear normally.
Acknowledgment is a human UI action and is not exposed as a WebMCP tool.
Undo restores only unchanged Agent choices and records another audit entry; newer
human corrections are preserved. Undo does not reopen or expand the session.
Agent review's Stop is separate from the worker's Pause all work control. Subsequent
matching follows the existing live automation permissions.

## Application boundaries and observability

Authenticated endpoints live under `/api/review/agent-sessions`. Thin routes dispatch
NextSignal API processes; the service owns selection, transactions and persistence.
The ordinary category PATCH stamps Human, while the batch service stamps Agent.
Clients cannot select their provenance. Session ownership, schemas, scopes,
snapshots, availability and allowed categories are checked on the server.

WebMCP registration is isolated in `lib/webmcp.ts`. It supports the current
Document API and older Navigator API, cleans up tools on navigation/logout, and
does not overwrite unrelated registrations or install a fake global API.

The existing log adapters emit session start, batch summary, Stop, Undo, rejection
and failure events. Each changed category has its own durable audit entry with
source, account, before/after category, original classification reference, reason
and agent session ID. Successful agent labels do not produce individual info logs.

Implementation tests use isolated data and mocked classifications. Deploying this
feature does not start production category review or any paid/provider request.
