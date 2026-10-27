-- Download health is shared by workers. Cooling hosts do not occupy import slots.
ALTER TABLE host_limits ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0);
ALTER TABLE host_limits ADD COLUMN cooldown_until timestamptz;
ALTER TABLE host_limits ADD COLUMN last_failure_at timestamptz;
ALTER TABLE host_limits ADD COLUMN last_success_at timestamptz;
CREATE INDEX host_limits_cooling ON host_limits(cooldown_until) WHERE cooldown_until IS NOT NULL;
