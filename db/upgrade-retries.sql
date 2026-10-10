-- Apply inside the persistence transaction while prediction writers are paused.
-- Existing rows have no trustworthy total request count. Close their unfinished
-- budgets rather than granting additional requests to an already attempted run.
ALTER TABLE epl_oracle.attempts ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE epl_oracle.attempts ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE epl_oracle.attempts ADD COLUMN IF NOT EXISTS claim_token text;
ALTER TABLE epl_oracle.attempts DROP CONSTRAINT IF EXISTS attempts_status_check;
ALTER TABLE epl_oracle.attempts ADD CONSTRAINT attempts_status_check CHECK (status IN ('started', 'succeeded', 'failed', 'exhausted', 'expired'));
UPDATE epl_oracle.attempts a SET status=CASE
  WHEN r.run_key LIKE 'weekly:%' AND now() >= r.scheduled_at + INTERVAL '24 hours' THEN 'expired'
  ELSE 'exhausted' END
FROM epl_oracle.runs r
WHERE a.run_id=r.id AND a.status IN ('started','failed') AND a.attempt_count=0
  AND NOT EXISTS (SELECT 1 FROM epl_oracle.metadata WHERE key='retry_schema_v1');
INSERT INTO epl_oracle.metadata (key,value) VALUES ('retry_schema_v1','{"verified":true}') ON CONFLICT (key) DO NOTHING;
