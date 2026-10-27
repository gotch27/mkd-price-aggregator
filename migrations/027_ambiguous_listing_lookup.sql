-- Identity checks need the exceptional ambiguous observations, rather than a
-- scan of every normal branch listing on every catalog publication.
CREATE INDEX listings_ambiguous_observation ON listings(retailer,id)
WHERE coalesce((raw->>'identity_ambiguous')::boolean,false);
