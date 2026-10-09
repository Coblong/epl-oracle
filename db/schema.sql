CREATE SCHEMA IF NOT EXISTS epl_oracle;

CREATE TABLE IF NOT EXISTS epl_oracle.metadata (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS epl_oracle.fixtures (
  id integer PRIMARY KEY,
  data jsonb NOT NULL,
  upcoming boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS epl_oracle.runs (
  id text PRIMARY KEY,
  run_key text NOT NULL UNIQUE,
  scheduled_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS epl_oracle.snapshots (
  run_id text NOT NULL REFERENCES epl_oracle.runs(id),
  fixture_id integer NOT NULL REFERENCES epl_oracle.fixtures(id),
  input jsonb,
  PRIMARY KEY (run_id, fixture_id)
);
CREATE TABLE IF NOT EXISTS epl_oracle.predictions (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL,
  fixture_id integer NOT NULL,
  provider text NOT NULL,
  match_signature text,
  generated_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  FOREIGN KEY (run_id, fixture_id) REFERENCES epl_oracle.snapshots(run_id, fixture_id),
  UNIQUE (run_id, fixture_id, provider)
);
CREATE INDEX IF NOT EXISTS predictions_latest ON epl_oracle.predictions(fixture_id, provider, generated_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS epl_oracle.attempts (
  run_id text NOT NULL,
  fixture_id integer NOT NULL,
  provider text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, fixture_id) REFERENCES epl_oracle.snapshots(run_id, fixture_id),
  PRIMARY KEY (run_id, fixture_id, provider)
);
CREATE TABLE IF NOT EXISTS epl_oracle.results (
  fixture_id integer PRIMARY KEY REFERENCES epl_oracle.fixtures(id),
  prediction_id bigint NOT NULL REFERENCES epl_oracle.predictions(id),
  data jsonb NOT NULL
);
