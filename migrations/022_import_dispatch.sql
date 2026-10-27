-- Reserve import capacity before queue publication. Tokens make stale deliveries
-- harmless; next_attempt_at keeps source retry waits outside worker slots.
ALTER TABLE runs ADD COLUMN dispatch_token uuid;
ALTER TABLE runs ADD COLUMN dispatch_until timestamptz;
ALTER TABLE runs ADD COLUMN dispatched_at timestamptz;
ALTER TABLE runs ADD COLUMN next_attempt_at timestamptz;
CREATE INDEX runs_import_dispatch ON runs(status,next_attempt_at,created_at)
  WHERE task_id IS NOT NULL AND kind IN ('discover','catalog');
CREATE UNIQUE INDEX runs_import_dispatch_token ON runs(dispatch_token)
  WHERE dispatch_token IS NOT NULL;
CREATE INDEX runs_import_fairness ON runs(retailer,dispatched_at DESC)
  WHERE dispatched_at IS NOT NULL;
