-- Keep decision provenance and filtering independent of expensive listing joins.
ALTER TABLE match_decisions ADD COLUMN retailer text;
ALTER TABLE match_decisions ADD COLUMN listing_name text;
UPDATE match_decisions d SET retailer=l.retailer,listing_name=l.name FROM listings l WHERE l.id=d.listing_id;
ALTER TABLE match_decisions ALTER COLUMN retailer SET NOT NULL;
ALTER TABLE match_decisions ALTER COLUMN listing_name SET NOT NULL;
CREATE INDEX decisions_retailer_created ON match_decisions(retailer,created_at DESC,id DESC);
CREATE INDEX decisions_name ON match_decisions USING gin(listing_name gin_trgm_ops);
CREATE FUNCTION decision_source_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_retailer text; source_name text;
BEGIN
 SELECT retailer,name INTO STRICT source_retailer,source_name FROM listings WHERE id=NEW.listing_id;
 IF NEW.retailer IS NOT NULL AND NEW.retailer<>source_retailer THEN
   RAISE EXCEPTION 'Decision retailer must match its source listing';
 END IF;
 NEW.retailer=source_retailer;
 NEW.listing_name=source_name;
 RETURN NEW;
END;
$$;
CREATE TRIGGER decision_source_metadata BEFORE INSERT ON match_decisions
FOR EACH ROW EXECUTE FUNCTION decision_source_metadata();
ANALYZE match_decisions;
