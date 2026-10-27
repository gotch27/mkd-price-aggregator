# Login protection and inventory summary

## Login incident

The production account had 19 attempts in one 15-minute window, exceeding its
configured limit of 10. The previous implementation counted every attempt under
the administrator's username and checked this shared limit before checking the
password. This could block a correct password from another connection. Previous
rejections had no reason-specific event, so the records cannot establish which
earlier attempts supplied an incorrect password.

The shared counter was cleared following the user's report. The replacement
counts failed credentials per trusted proxy client address, serialized with a
transactional advisory lock. Successful sign-ins clear only that client's failed
attempts and never increase a counter. Rejected attempts during a blocked window
do not extend its expiry. A different connection is independent; devices sharing
one public address share its failed-password guard.

Incorrect credentials return HTTP 401. A temporary guard returns HTTP 429 with
`Retry-After`; an unexpected sign-in service failure returns a sanitized 503.
The form no longer combines these cases in one misleading message. Mobile
capitalization, autocorrection and spell checking are disabled on credential
fields. Passwords are still compared exactly.

`auth.login.authenticated` (info), `auth.login.invalid` (warn), and
`auth.login.limited` (warn) use the existing log adapter and process correlation.
Events contain a truncated HMAC client key and the configured account, without
passwords, sessions, or raw addresses. Existing operational retention applies.

`auth.login_client_header` is required centralized configuration, defaulting to
`cf-connecting-ip`, with root override
`NEXTSIGNAL_AUTH__LOGIN_CLIENT_HEADER`. The production web port is loopback-only;
public traffic arrives through Cloudflare Tunnel, which supplies this header.
Only trust a header that the deployment's reverse proxy owns and overwrites.
If that architecture changes, update the trusted header and prevent direct
public access from forging it. Missing or malformed addresses share an
`unidentified` guard rather than bypassing protection.

## Inventory layout

Store cards show four plain counts on one row: unique products, available,
unavailable, and price observations. An uninitialized count displays a dash;
known zero remains zero. Unknown availability, if present, is separate text.
The metric sizes adapt to the card width without adding numerical pills.

Overview highlights available products, all listed products, groups matched
across stores, and monthly AI spending. Product counts are unique within each
chain; a product listed by several chains contributes once per chain. Available
means explicitly available in at least one active branch. The listed total also
contains unavailable products, whose count is shown underneath.

Catalog coverage includes freshness, using the configured
`ingestion.freshness_hours` window. Recent, due for refresh, and never imported
counts share the same panel and store grid. There is no separate freshness
panel. These are read-only presentation changes using the existing saved
statistics; no import, categorization, matching, or paid request is started.

## Verification

Isolated tests exercise independent clients, successful logins, concurrent failed
attempts, expired windows, legacy shared counters, safe logging, proxy-header
parsing, and HTTP/cookie behavior. Dashboard statistics tests cover the existing
counts. Deployment verification checks authentication, protected summary reads,
service health, and preservation of operational settings and task/AI counters.

Delivery checks: 484 isolated tests passed, type checking passed, and the homelab
production image built successfully. Live HTTP checks returned 401 for an
incorrect password, 429 with a retry interval for a synthetic blocked client,
and 200 for a correct password both internally and through the public hostname.
Secure session-cookie flags and all three authentication log events were checked.
The rendered store components contained four plain counts for each of nine stores;
the rendered Overview included coverage and freshness in one panel. This was
server rendering and HTTP verification, without an interactive browser check.
The summary reported 131,977 available and 59,072 unavailable products, with no
unknown availability. Operational settings, task counts, classifications,
corrections, match decisions, and AI request counts were unchanged.
