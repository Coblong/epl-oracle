-- Expand the existing constraint without rewriting forecasts or evaluations.
ALTER TABLE epl_oracle.result_predictions DROP CONSTRAINT IF EXISTS result_predictions_provider_check;
ALTER TABLE epl_oracle.result_predictions ADD CONSTRAINT result_predictions_provider_check
  CHECK (provider IN ('jev','openai','claude','chatgpt','gemini'));

-- Only new attempts are audited; do not invent metadata for historical requests.
CREATE TABLE IF NOT EXISTS epl_oracle.attempt_history (
  run_id text NOT NULL,
  fixture_id integer NOT NULL,
  provider text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL CHECK (status IN ('started','succeeded','failed','exhausted','expired','abandoned')),
  metadata jsonb,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (run_id,fixture_id,provider,attempt_number),
  FOREIGN KEY (run_id,fixture_id) REFERENCES epl_oracle.snapshots(run_id,fixture_id)
);
