ALTER TABLE offers ADD COLUMN source_url text;
UPDATE offers o SET source_url=s.url FROM sources s WHERE s.id=o.source_id;
ALTER TABLE offers ALTER COLUMN source_url SET NOT NULL;
UPDATE runs r SET checkpoint=r.checkpoint || jsonb_build_object('source_url',s.url) FROM sources s WHERE r.source_id=s.id AND r.kind='catalog' AND NOT(r.checkpoint ? 'source_url');
