# Stokomak and Žito discovery failure — 25 October 2026

## Finding

The homelab manual import task `717df024-3954-40cd-9629-2cc92b4cbaff`
created one discovery run per chain. Žito's discovery failed at 09:55:36 UTC;
Stokomak's failed at 09:55:43 UTC. Each started once, spent approximately 21.5
seconds, and ended with `No published ... catalogs discovered`. Neither run was
retried (`retry_failures=0`), so no branch-price runs were created for these chains.
Other chains continued to download and publish.

One bounded homepage request per chain from the homelab reproduced an 85-byte
plain-text response reporting `Error fetching organizations` and an internal
upstream connection timeout. Independent requests from the development machine
returned the same body, HTTP 200, and approximately 21.5–21.7 second durations.
The failure is inside the price platform rather than the app's Cloudflare tunnel,
Docker DNS, or the homelab's connection to the public price websites. Both chains
report the same internal target. No attempt was made to access that private target.

## Application correction

Our HTTP client previously accepted the 200 response and marked the host healthy.
The discovery parser found no store options and classified it as a permanent
missing-catalog failure. That classification skipped the existing retry policy.

`nextsignal/services/source-response.ts` recognizes the known plain-text connection
error before successful-response accounting. It returns a retryable source error
with a plain-language explanation. `http.ts` preserves its structured diagnostics
and counts it toward the shared host cooldown. Repeated HTTP-200 errors can no
longer repeatedly reset the failure count. A later valid response permits normal
recovery.

Discovery logs now distinguish an unavailable store list from a catalog price
download. Retry warnings include the original HTTP status, the provider operation,
the failure type, and the next retry time. Raw response bodies and internal
addresses are kept out of application logs.

The detector is restricted to the provider's plain-text error envelope and known
connection failures. A matching phrase inside HTML product text or a JSON name
does not trigger it. Unknown provider errors and genuine parser/layout problems
are not silently reinterpreted. Catalog completeness, snapshot confirmation,
current prices, matching memory, and manual settings are unchanged.

Increasing our timeout cannot repair the platform's own failed connection. The
application can wait safely and try again within its configured allowance; the
platform operator must restore its upstream service. No deployment can guarantee
that an unavailable third-party site will recover within that allowance.

## Verification

Isolated tests exercise the exact 85-byte response with its UTF-8 BOM, both chains,
HTTP-200 cooldown accumulation, recovery after a valid response, and false-positive
guards. A process-level test retries discovery after an outage, completes when a
valid store list returns, and preserves existing prices without importing any
catalog. No paid calls or full import were started for diagnostics.

All 369 isolated tests, type checking, production builds, and public HTTPS checks
passed. The fix was deployed to the homelab web/worker images. The existing manual
import continued from saved checkpoints; post-deployment checks observed SPAR
saving new pages. Saved task settings were unchanged, AI usage remained zero,
and no new application errors were recorded during deployment verification.

The two original failed discovery runs remain unchanged at one attempt each.
Deployment did not grant them a new retry allowance or create a new campaign.
After the provider recovers, use **Retry unfinished** for the import task to
explicitly retry these failures. Future attempts recognize the HTTP-200 outage
and apply the normal bounded retry/cooldown policy. Historical failure messages
are retained rather than rewritten.
