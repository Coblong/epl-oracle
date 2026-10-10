CREATE TABLE IF NOT EXISTS epl_oracle.fixture_results (
  fixture_id integer PRIMARY KEY REFERENCES epl_oracle.fixtures(id),
  status text NOT NULL CHECK (status IN ('completed','cancelled')),
  gameweek integer,
  kickoff timestamptz,
  home jsonb NOT NULL,
  away jsonb NOT NULL,
  actual_home_score integer CHECK (actual_home_score IS NULL OR actual_home_score >= 0),
  actual_away_score integer CHECK (actual_away_score IS NULL OR actual_away_score >= 0),
  updated_at timestamptz NOT NULL,
  CHECK ((status = 'completed' AND actual_home_score IS NOT NULL AND actual_away_score IS NOT NULL)
    OR (status = 'cancelled' AND actual_home_score IS NULL AND actual_away_score IS NULL))
);

CREATE TABLE IF NOT EXISTS epl_oracle.result_predictions (
  fixture_id integer NOT NULL REFERENCES epl_oracle.fixture_results(fixture_id),
  provider text NOT NULL CHECK (provider IN ('jev','openai')),
  prediction_id bigint NOT NULL REFERENCES epl_oracle.predictions(id),
  eligible boolean NOT NULL,
  correct_outcome boolean,
  correct_score boolean,
  evaluated_at timestamptz NOT NULL,
  PRIMARY KEY (fixture_id, provider),
  CHECK (eligible OR (correct_outcome IS NULL AND correct_score IS NULL))
);

