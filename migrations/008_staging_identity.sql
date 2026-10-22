CREATE INDEX staging_identity_base ON staging(run_id, (data->'raw'->>'identity_base'));
