CREATE TABLE local_product_keys (
 retailer text NOT NULL, identity_hash text NOT NULL, external_key text NOT NULL,
 listing_id uuid NOT NULL REFERENCES listings(id), version text NOT NULL, rule_key text,
 PRIMARY KEY(retailer,identity_hash,external_key)
);
CREATE INDEX local_product_keys_rule ON local_product_keys(rule_key) WHERE rule_key IS NOT NULL;
