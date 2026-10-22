import { settings } from "@/nextsignal/config";
import {
  conflicts,
  complete,
  validGtin,
  hash,
} from "@/nextsignal/domain/normalize";
import type { Attributes } from "@/nextsignal/domain/types";
import { pool, transaction } from "./database";
import {
  equivalent,
  extractAttributes,
  AiDeferred,
  aiBudgetAvailable,
} from "./ai";
import { loggerAdapter } from "@/nextsignal/adapters/logger";
import {
  localRuleKey,
  localMatchingVersion,
} from "@/nextsignal/domain/local-matching";
export function compatibleGroup(attributes: Attributes[]) {
  return attributes.every((a, i) =>
    attributes.slice(i + 1).every((b) => !conflicts(a, b)),
  );
}

type Listing = {
  id: string;
  name: string;
  category: string | null;
  normalized_name: string;
  identity_hash: string;
  product_id: string;
  attributes: Attributes;
  retailer: string;
  external_key: string;
};
type MatchingScope = {
  sourceId: string | null;
  retailer: string | null;
  namespace: string | null;
};
type AcceptedCandidate = {
  id: string;
  identity_hash: string;
  method: string;
  probability: number;
};
type MatchingDecision = {
  listing: Listing;
  attrs: Attributes;
  accepted: Map<string, AcceptedCandidate>;
  evidence: unknown[];
  deferred: boolean;
  usedAi: boolean;
};

export async function matchBatch(runId: string, sourceId: string | null) {
  const allowAi = await aiBudgetAvailable(runId);
  const scope = await matchingScope(sourceId);
  const ambiguous = await recordAmbiguities(scope);
  const batch = await unmatchedListings(scope, allowAi);
  let matched = 0;
  for (const listing of batch)
    if (await matchListing(runId, listing, allowAi)) matched++;
  return {
    processed: ambiguous + batch.length,
    ambiguous,
    matched,
    ai_disabled: !settings.matching.ai.enabled,
    ai_budget_limited: settings.matching.ai.enabled && !allowAi,
    more:
      ambiguous === settings.matching.ambiguity_batch_size ||
      batch.length === settings.matching.batch_size,
  };
}

async function matchingScope(sourceId: string | null): Promise<MatchingScope> {
  if (sourceId === null) return { sourceId, retailer: null, namespace: null };
  const source = (
    await pool.query<{ retailer: string; external_id: string }>(
      "SELECT retailer,external_id FROM sources WHERE id=$1",
      [sourceId],
    )
  ).rows[0];
  if (!source) throw new Error("Matching source not found");
  return { sourceId, retailer: source.retailer, namespace: source.external_id };
}

async function recordAmbiguities(scope: MatchingScope) {
  // Known ambiguity is a deterministic abstention. Record it in a bounded bulk
  // transaction without model calls or a separate transaction per listing.
  return transaction(async (c) => {
    const rows = (
      await c.query(
        `SELECT l.id, l.identity_hash, l.product_id, l.attributes
         FROM listings l
         WHERE l.attributes->>'ambiguous' = 'true'
           AND l.matched_hash IS DISTINCT FROM l.identity_hash
           AND l.next_match_at <= now()
           AND ($2::text IS NULL OR l.retailer = $2)
           AND ($3::text IS NULL OR l.namespace = $3)
           AND EXISTS (
             SELECT 1 FROM offers o JOIN sources s ON s.id = o.source_id
             WHERE o.listing_id = l.id AND s.active
               AND ($1::uuid IS NULL OR o.source_id = $1)
           )
         LIMIT $4 FOR UPDATE OF l SKIP LOCKED`,
        [
          scope.sourceId,
          scope.retailer,
          scope.namespace,
          settings.matching.ambiguity_batch_size,
        ],
      )
    ).rows;
    if (!rows.length) return 0;
    await c.query(
      `INSERT INTO match_decisions(listing_id,identity_hash,product_id,method,probability,evidence,model,prompt_version)
       SELECT (r->>'id')::uuid,r->>'identity_hash',NULL,'ambiguous',NULL,
         jsonb_build_object('attributes',r->'attributes','candidates','[]'::jsonb,'deferred',false,'previous_products',jsonb_build_array(r->>'product_id')),NULL,$2
       FROM jsonb_array_elements($1::jsonb) r`,
      [JSON.stringify(rows), settings.matching.prompt_version],
    );
    await c.query(
      "UPDATE listings SET matched_hash=identity_hash,next_match_at=now()+$2*interval '1 hour' WHERE id=ANY($1::uuid[])",
      [rows.map((row) => row.id), settings.matching.retry_hours],
    );
    return rows.length;
  });
}

async function unmatchedListings(scope: MatchingScope, allowAi: boolean) {
  // The deterministic eligibility predicate has its own partial index. Disabled
  // AI must not cause a full-table scan or rewrite of every incomplete identity.
  const base = (
    await pool.query<Listing>(
      `SELECT l.* FROM listings l
       WHERE l.next_match_at <= now()
         AND l.matched_hash IS DISTINCT FROM l.identity_hash
         AND l.attributes->>'ambiguous' = 'false'
         AND l.normalized_name ~ '[a-z]'
         AND ($4::text IS NULL OR l.retailer = $4)
         AND ($5::text IS NULL OR l.namespace = $5)
         AND (
           $3::boolean OR l.attributes->>'ambiguous' = 'true'
           OR l.attributes->>'gtin' IS NOT NULL
           OR (
             l.attributes->>'brand' IS NOT NULL
             AND l.attributes->>'variant' IS NOT NULL
             AND l.attributes->>'quantity' IS NOT NULL
             AND l.attributes->>'unit' IS NOT NULL
             AND l.attributes->>'pack' IS NOT NULL
             AND l.attributes->>'form' IS NOT NULL
           )
         )
         AND EXISTS (
           SELECT 1 FROM offers o JOIN sources s ON s.id = o.source_id
           WHERE o.listing_id = l.id AND s.active
             AND ($2::uuid IS NULL OR s.id = $2)
         )
       ORDER BY l.next_match_at LIMIT $1`,
      [
        settings.matching.batch_size,
        scope.sourceId,
        allowAi,
        scope.retailer,
        scope.namespace,
      ],
    )
  ).rows;
  if (
    !settings.matching.local.enabled ||
    base.length >= settings.matching.batch_size
  )
    return base;
  const local = (
    await pool.query<Listing>(
      `SELECT l.* FROM local_product_keys k JOIN listings l ON l.id=k.listing_id
     WHERE k.version=$1 AND k.rule_key IS NOT NULL AND l.identity_hash=k.identity_hash
       AND l.next_match_at<=now() AND l.matched_hash IS DISTINCT FROM l.identity_hash
       AND ($2::text IS NULL OR l.retailer=$2)
       AND ($4::uuid IS NULL OR EXISTS(
         SELECT 1 FROM offers scoped_offer JOIN listings scoped ON scoped.id=scoped_offer.listing_id
         WHERE scoped_offer.source_id=$4 AND scoped.retailer=l.retailer
           AND scoped.identity_hash=l.identity_hash AND scoped.external_key=l.external_key
       ))
       AND EXISTS (SELECT 1 FROM offers o JOIN sources s ON s.id=o.source_id
         WHERE o.listing_id=l.id AND s.active)
     ORDER BY l.next_match_at,l.id LIMIT $3`,
      [
        localMatchingVersion(settings.matching.local),
        scope.retailer,
        settings.matching.batch_size,
        scope.sourceId,
      ],
    )
  ).rows;
  const unique = new Map(
    [...base, ...local].map((listing) => [listing.id, listing]),
  );
  return [...unique.values()].slice(0, settings.matching.batch_size);
}

async function matchListing(runId: string, listing: Listing, allowAi: boolean) {
  let attrs = listing.attributes;
  let deferred = false;
  let usedAi = false;
  const current = (
    await pool.query(
      "SELECT match_status,matched_hash,identity_hash,product_id FROM listings WHERE id=$1",
      [listing.id],
    )
  ).rows[0];
  if (
    current.identity_hash !== listing.identity_hash ||
    current.matched_hash === current.identity_hash
  )
    return false;
  listing.product_id = current.product_id;
  if (
    allowAi &&
    settings.matching.ai.extraction &&
    !attrs.ambiguous &&
    !attrs.gtin &&
    !complete(attrs) &&
    localRuleKey(listing.name, attrs, settings.matching.local) === null
  )
    try {
      usedAi = true;
      const a = await extractAttributes(listing.name, listing.category, runId);
      if (a) {
        const merged = { ...attrs };
        merged.ambiguous = merged.ambiguous || a.ambiguous;
        for (const key of [
          "brand",
          "variant",
          "quantity",
          "unit",
          "pack",
          "form",
        ] as const)
          if (merged[key] === null)
            (merged as Record<string, unknown>)[key] = a[key];
        attrs = merged;
      }
    } catch (error) {
      deferred = true;
      await loggerAdapter.warn({
        message: "AI extraction deferred",
        data: { run_id: runId, listing_id: listing.id },
        error,
      });
    }
  const ruleKey = localRuleKey(listing.name, attrs, settings.matching.local);
  const localCandidates =
    ruleKey === null
      ? []
      : (
          await pool.query<Listing>(
            `SELECT l.* FROM local_product_keys k JOIN listings l ON l.id=k.listing_id
     WHERE k.version=$1 AND k.rule_key=$2 AND l.id<>$3 AND l.product_id<>$4
       AND l.identity_hash=k.identity_hash
       AND EXISTS(SELECT 1 FROM offers o JOIN sources s ON s.id=o.source_id WHERE o.listing_id=l.id AND s.active)
     ORDER BY l.id LIMIT $5`,
            [
              localMatchingVersion(settings.matching.local),
              ruleKey,
              listing.id,
              listing.product_id,
              settings.matching.candidate_limit,
            ],
          )
        ).rows;
  const fuzzyCandidates =
    attrs.ambiguous || (ruleKey !== null && !attrs.gtin && !allowAi)
      ? []
      : (
          await pool.query<Listing>(
            `SELECT l.*, similarity(l.normalized_name, $1) AS similarity
           FROM listings l
           WHERE l.id <> $2 AND l.product_id <> $3
             AND (l.normalized_name % $1 OR ($4::text IS NOT NULL AND l.gtin = $4))
             AND EXISTS (
               SELECT 1 FROM offers o JOIN sources s ON s.id = o.source_id
               WHERE o.listing_id = l.id AND s.active
             )
           ORDER BY (l.gtin = $4) DESC NULLS LAST, similarity DESC
           LIMIT $5`,
            [
              listing.normalized_name,
              listing.id,
              listing.product_id,
              attrs.gtin,
              settings.matching.candidate_limit,
            ],
          )
        ).rows;
  const candidates = [
    ...new Map(
      [...localCandidates, ...fuzzyCandidates].map((candidate) => [
        candidate.id,
        candidate,
      ]),
    ).values(),
  ].slice(0, settings.matching.candidate_limit);
  const accepted = new Map<string, AcceptedCandidate>();
  const evidence: unknown[] = [];
  for (const candidate of candidates) {
    if (accepted.has(candidate.product_id)) continue;
    const other = candidate.attributes;
    if (conflicts(attrs, other)) continue;
    const members = (
      await pool.query("SELECT attributes FROM listings WHERE product_id=$1", [
        candidate.product_id,
      ])
    ).rows;
    if (members.some((m) => conflicts(attrs, m.attributes))) continue;
    let method: string | null = null,
      p: number | null = null;
    if (attrs.gtin && validGtin(attrs.gtin) && attrs.gtin === other.gtin) {
      method = "gtin";
      p = 1;
    } else if (
      ruleKey !== null &&
      ruleKey === localRuleKey(candidate.name, other, settings.matching.local)
    ) {
      method = "local-rules";
      p = 1;
    } else if (
      complete(attrs) &&
      complete(other) &&
      listing.normalized_name === candidate.normalized_name &&
      hash({ ...attrs, gtin: null }) === hash({ ...other, gtin: null })
    ) {
      method = "fingerprint";
      p = 1;
    } else if (allowAi)
      try {
        usedAi = true;
        p = await equivalent(
          {
            a: {
              name: listing.name,
              category: listing.category,
              attributes: attrs,
            },
            b: {
              name: candidate.name,
              category: candidate.category,
              attributes: other,
            },
          },
          runId,
        );
        method = "decisions";
      } catch (error) {
        deferred = true;
        await loggerAdapter.warn({
          message:
            error instanceof AiDeferred
              ? error.message
              : "AI judgment deferred",
          data: { run_id: runId, listing_id: listing.id },
          error,
        });
        break;
      }
    evidence.push({
      candidate: candidate.id,
      product_id: candidate.product_id,
      probability: p,
      method,
    });
    if (method && p !== null && p >= settings.matching.threshold)
      accepted.set(candidate.product_id, {
        id: candidate.id,
        identity_hash: candidate.identity_hash,
        method,
        probability: p,
      });
  }
  return commitDecision({
    listing,
    attrs,
    accepted,
    evidence,
    deferred,
    usedAi,
  });
}

// Recheck evidence under row locks before joining whole groups. A catalog may
// have changed a listing while a provider request was in flight.
async function commitDecision({
  listing,
  attrs,
  accepted,
  evidence,
  deferred,
  usedAi,
}: MatchingDecision) {
  return transaction(async (c) => {
    const fresh = (
      await c.query(
        "SELECT identity_hash,product_id FROM listings WHERE id=$1 FOR UPDATE",
        [listing.id],
      )
    ).rows[0];
    if (fresh.identity_hash !== listing.identity_hash) return false;
    const copies = (
      await c.query<{ product_id: string }>(
        `SELECT copy.product_id FROM listings seed JOIN listings copy
           ON copy.retailer=seed.retailer AND copy.identity_hash=seed.identity_hash
             AND copy.external_key=seed.external_key
         WHERE seed.id=ANY($1::uuid[]) ORDER BY copy.id FOR UPDATE OF copy`,
        [
          [
            listing.id,
            ...[...accepted.values()].map((candidate) => candidate.id),
          ],
        ],
      )
    ).rows;
    const productIds = [
      ...new Set([
        ...accepted.keys(),
        fresh.product_id,
        ...copies.map((copy) => copy.product_id),
      ]),
    ];
    let target: string | null = null,
      method = attrs.ambiguous ? "ambiguous" : "separate",
      probability: number | null = null;
    if (accepted.size) {
      const members = (
        await c.query(
          "SELECT id,identity_hash,attributes FROM listings WHERE product_id=ANY($1::uuid[]) FOR UPDATE",
          [productIds],
        )
      ).rows;
      const unchanged = [...accepted.values()].every((a) =>
        members.some(
          (m) => m.id === a.id && m.identity_hash === a.identity_hash,
        ),
      );
      if (
        unchanged &&
        compatibleGroup([
          attrs,
          ...members.map((m) => (m.id === listing.id ? attrs : m.attributes)),
        ])
      ) {
        target = (
          await c.query(
            "SELECT id FROM products WHERE id=ANY($1::uuid[]) AND redirect_id IS NULL ORDER BY created_at,id LIMIT 1",
            [productIds],
          )
        ).rows[0].id;
        method = [...accepted.values()].some((v) => v.method === "decisions")
          ? "decisions"
          : [...accepted.values()][0].method;
        probability = Math.min(
          ...[...accepted.values()].map((v) => v.probability),
        );
        await c.query(
          "UPDATE listings SET product_id=$2,match_status='matched',matched_hash=identity_hash WHERE product_id=ANY($1::uuid[])",
          [productIds, target],
        );
        await c.query(
          "UPDATE products SET redirect_id=$2 WHERE id=ANY($1::uuid[]) AND id<>$2",
          [productIds, target],
        );
      } else method = unchanged ? "ambiguous" : "stale-evidence";
    }
    await c.query(
      "INSERT INTO match_decisions(listing_id,identity_hash,product_id,method,probability,evidence,model,prompt_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        listing.id,
        listing.identity_hash,
        target,
        method,
        probability,
        {
          attributes: attrs,
          candidates: evidence,
          deferred,
          previous_products: productIds,
        },
        usedAi ? settings.matching.ai.model : null,
        settings.matching.prompt_version,
      ],
    );
    await c.query(
      `UPDATE listings SET attributes=$2,matched_hash=$3,next_match_at=now()+$4*interval '1 hour'
       WHERE retailer=$1 AND identity_hash=$5 AND external_key=$6`,
      [
        listing.retailer,
        attrs,
        target || !deferred ? listing.identity_hash : null,
        settings.matching.retry_hours,
        listing.identity_hash,
        listing.external_key,
      ],
    );
    return target !== null;
  });
}
