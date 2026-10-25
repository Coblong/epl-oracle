# The EPL Oracle

A Premier League fixture dashboard with scheduled forecasts from Jev, Decisions API, Claude, ChatGPT and Gemini. Deploys to Vercel as a static frontend plus serverless functions, with Neon Postgres persistence after a verified migration.

See [prediction agents](docs/prediction-agents.md) for the five-agent API contract, credentials, limits, usage estimates and migration. See [competition verification](docs/competition-verification.md) for the activation boundary, manual run and release checks.

## Architecture

- **Persistence is selected explicitly.** `PERSISTENCE_BACKEND=blob` retains the original three JSON files until cutover. `PERSISTENCE_BACKEND=neon` uses fixtures, runs, input snapshots, prediction revisions, attempts and results in Postgres. Neon imports must pass validation before the application can use them. API requests read persisted data; they do not call prediction providers.
- **Fixture and prediction schedules operate independently:**
  - Fixture refresh runs through the GitHub Actions workflow, fetching official fixtures and results from the Fantasy Premier League API.
  - `/api/cron/predictions` starts the weekly run Wednesday at 09:00 Europe/London. UTC cron calls continue through Thursday 09:00 London so a missed start can recover the same run. Database claims prevent overlapping calls from duplicating a provider request.
- **Read-only API routes serve the frontend:** `/api/fixtures` merges the persisted fixture list with each provider’s latest successful forecast; `/api/results` returns paginated current-season results and full-history summaries for all five agents, including O Score alongside outcome, exact-score and Brier metrics.
- **Competition activation is explicit:** a secret-protected POST records the activation instant once. Its cohort includes only fixtures kicking off at or after that instant. A separate secret-protected manual prediction run covers the next ten days and can retry for 24 hours; the regular weekly schedule and its guard remain unchanged. See [competition verification](docs/competition-verification.md).

## Run locally

```sh
npm install
vercel link      # first time only, links this directory to a Vercel project
vercel env pull .env.local
vercel dev        # do not wrap this in an npm script — `vercel dev` detects and refuses that recursion
```

For five-agent predictions, configure `AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DATABASE_URL` and `PERSISTENCE_BACKEND=neon` in `.env.local`. Use a validated, isolated `DATABASE_SCHEMA` for local and preview work so manual jobs do not change production. Keep the Blob token for migration and rollback. Once the schema is initialized and imported, you can trigger jobs locally:

```sh
curl http://localhost:3000/api/cron/fixtures
curl http://localhost:3000/api/cron/predictions
```

The activation and manual competition routes also require `CRON_SECRET`; see the verification guide before using them.

Run `npm test` for fixture, prediction, accuracy and migration-source tests. Set `TEST_DATABASE_URL` to also run real PostgreSQL integration tests; these use a temporary schema and remove it afterward. See [migration and rollback](docs/neon-migration.md) for the database verification and cutover procedure.

## Deploy to Vercel

1. `vercel link` then `vercel` (or push to a Git repo connected to a Vercel project).
2. Add a **Blob** store to the project (Storage tab) — this sets `BLOB_READ_WRITE_TOKEN` automatically for all environments.
3. Set the server-only provider credentials listed in [prediction agents](docs/prediction-agents.md), including `ANTHROPIC_WORKSPACE_ID` when the Claude key requires it. For Neon, also set the pooled `DATABASE_URL` and complete [migration validation](docs/neon-migration.md) before setting `PERSISTENCE_BACKEND=neon`. Keep the Blob token for migration and rollback.
4. Set `CRON_SECRET` for protected activation and manual competition runs. Vercel sends it as a Bearer token on Cron Jobs requests.
5. Deploy. GitHub Actions refreshes fixtures and results; `vercel.json` schedules prediction calls on Wednesday and Thursday. The London-time guard covers GMT and BST, and Vercel Hobby may invoke within the scheduled UTC hour. Before data is loaded, the fixtures endpoint reports "not loaded yet". Neon requires an initialized schema and verified import before serving data.

## Behaviour

- Shows all unstarted future fixtures, including undated ones, with pagination, team search and gameweek filtering.
- Every Wednesday, predictions cover dated, unstarted fixtures in the next 240 hours from the scheduled run time. All five agents refresh even when evidence is unchanged. A new run requires fixture data no older than 24 hours; recovery reuses the saved snapshot. Older successful forecasts remain visible with their generation date and an earlier-evidence label. Neon preserves earlier revisions and input snapshots, and saves each successful forecast with its attempt status.
- Sends all five agents equivalent current-season league records, goals and the five most recent completed matches for each team. No fabricated fixtures, predictions or fallback model.
- Calls `POST https://ai-gateway.vercel.sh/v1/evaluate` with model `typesafe-ai/jev`. One choice question estimates probabilities for all 49 exact scorelines from 0–6 goals per team. All agents use the same result-first derivation described below. Invalid score distributions follow the normal scheduled retry policy.
- Once a fixture finishes, its prediction is compared against the real result and added to the **track record**: outcome-correct and exact-score-correct are tracked separately. The scoreboard summarizes all completed Neon results with eligible pre-kickoff forecasts, independent of season and pagination. All matches shows each provider’s full history; Same matches uses fixtures predicted by all five agents. Counts accompany result and score percentages. Blob history is not imported or included.
- Calls `POST https://api.openai.com/v1/decisions` with `gpt-6-luna`. The adapter sends the same single score choice question and rejects refused, incomplete or invalid responses. It retains the returned model identity.
- All five agents use an immutable shared fixture snapshot within a run. Each success commits separately. Failed or missing forecasts get at most three total attempts per provider, fixture and weekly run, at least 15 minutes apart and starting before Thursday 09:00 London. Each attempt makes one HTTP request. Atomic claims skip successful and exhausted work, recover abandoned calls after the backoff and reject late writes from replaced workers. Missing credentials, refusals, invalid answers, rate limits and timeouts record failures without inventing forecasts.
- Cards show fresh, retained and missing opinions from all five agents with refresh status and attempt counts. An exhausted or expired refresh retains any earlier forecast and its generation date. GET requests derive expiry without writing; prediction cron jobs and the GitHub fixture refresh workflow persist terminal states.
- The existing Hobby cron entries provide up to three eligible invocations per weekly window in GMT or BST. They do not guarantee three attempts: hour-wide invocation jitter can put adjacent calls less than 15 minutes apart, causing the later call to skip. Backoff specifies earliest eligibility; it does not schedule a request 15 minutes later.
- Fixture cards show each agent's probabilities, predicted result, predicted score and London generation timestamp. New outcome and score forecasts are derived from a single score distribution and always agree; older recorded forecasts retain their original values.

Matches and all five agents’ forecasts remain on Predictions after kickoff until a complete finished score is stored, then move to Results. A running score or elapsed kickoff alone does not remove them. Explicit cancellations are still removed. Unresolved matches show "Awaiting result" after a fixture refresh.

### Result-first forecasts

For all five agents, validate exactly 49 finite score probabilities between 0 and 1. Jev, Decisions, Claude and ChatGPT require a total within 0.02 of 1. Gemini accepts any nonzero total for a complete bounded distribution, normalizes it, and retains the original total for audit. Sum home-winning, drawn and away-winning scorelines to derive outcome probabilities. Choose the highest-probability result, then the highest-probability score within that result. The provider’s own global score choice does not override this selection.

For example, 1:1 at 30%, 2:1 at 26%, 1:0 at 24% and 0:1 at 20% yield home win 50%, draw 30%, away win 20%. Display home win and 2:1, prioritizing the result even though 1:1 is the globally most likely exact score. The labels are Predicted result and Predicted score.

Ties within 1e-12 are treated as equal to avoid floating-point noise. Score ties within a result prefer fewer total goals, then lower home goals, then lower away goals. Result ties prefer the strongest individual score within each tied result, then fewer goals in that score, then the fixed home/draw/away order. These rules are identical for all agents and independent of response ordering.

Each new prediction retains `scoreProbabilities` (the normalized 49-score distribution), `scoreProbabilityTotal` (its original sum), and `method: score-distribution-result-first-v1`, alongside the existing outcome, score, outcome probabilities, model and generation time. Jev and Decisions also retain their returned `providerScoreChoice`. Existing JSON persistence retains these fields without a migration. Older predictions and accuracy records are unchanged; no historical regeneration or Blob import. The 0–6 grid remains a modelling limitation. Improved accuracy and lower cost require measurement rather than being guaranteed by this change.

### Probability accuracy

The scoreboard uses the [multiclass Brier score](https://scikit-learn.org/1.7/modules/generated/sklearn.metrics.brier_score_loss.html): average `sum((p[outcome] - observed[outcome]) ** 2)` across home/draw/away, without dividing by the number of classes or halving. Its range is 0–2, lower is better. Probabilities must be finite, between 0 and 1, and sum to 1 within the existing 0.02 tolerance; accepted probabilities are normalized for scoring without modifying stored forecasts. Invalid or missing probability evidence does not affect outcome or exact-score denominators, but is excluded from the Brier denominator. Each Brier sample count is shown. In the shared comparison, a fixture contributes to shared Brier scores only if all five agents have valid probabilities, ensuring identical denominators. Empty histories show zero counts and no numeric accuracy or Brier score. Official score corrections are reflected at the next result refresh. No additional database migration is required for these summaries.

## Credentials

`AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `CRON_SECRET`, `BLOB_READ_WRITE_TOKEN` and `DATABASE_URL` are server-only Vercel environment variables, never sent to the browser. The app has no authentication of its own — before making this a public product, add one, plus per-user rate limits.

## References

- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions)

- [Vercel Jev HTTP API](https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev)
- [TypeSafe model documentation](https://docs.typesafe.ai/introduction)
- [Vercel Blob](https://vercel.com/docs/storage/vercel-blob)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
- [Official fixtures](https://fantasy.premierleague.com/api/fixtures/)
- [Official club metadata](https://fantasy.premierleague.com/api/bootstrap-static/)

### Fixture refresh workflow

See [fixture refresh setup and recovery](docs/fixture-refresh.md) for the GitHub runner access check, gated daily schedule, manual refresh and verified cutover. The GitHub daily refresh is enabled after a verified production run; Vercel now schedules only forecast generation. Fixture/result data older than 24 hours displays a warning.
