-- Canonical products are looked up by UUID; name candidates use listings_search.
DROP INDEX products_search;

CREATE INDEX listings_deterministic_due ON listings(next_match_at)
WHERE matched_hash IS DISTINCT FROM identity_hash
  AND (attributes->>'ambiguous'='true' OR attributes->>'gtin' IS NOT NULL OR
    (attributes->>'brand' IS NOT NULL AND attributes->>'variant' IS NOT NULL
      AND attributes->>'quantity' IS NOT NULL AND attributes->>'unit' IS NOT NULL
      AND attributes->>'pack' IS NOT NULL AND attributes->>'form' IS NOT NULL));
