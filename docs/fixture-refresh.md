# Fixture and result refresh

The Fixture refresh workflow fetches FPL directly from a GitHub-hosted runner. The website and weekly prediction jobs remain on Vercel. Both the CLI and the existing Vercel endpoint use `lib/fixture-refresh.mjs`, including result evaluation, score corrections and persisted-team fallback.

## Access check

Pull requests that change the workflow or feed code run a credential-free check of both FPL feeds. The check validates fixture identities, dates, scores and the team catalog. It does not connect to the database. A failed access check blocks the refresh job. If runner access is unreliable, keep the current schedule and evaluate a supported data source separately.

## Setup and cutover

1. Verify the pull request's Fixture refresh / access check passes.
2. Add repository secret `FIXTURE_DATABASE_URL` with a Neon connection string for the production schema. Prefer a dedicated refresh role with schema USAGE, SELECT on the schema's tables and INSERT/UPDATE on fixtures, metadata, attempts, fixture_results, result_predictions and results. It needs no schema creation, migrations, forecast writes or deletion permission. Keep the credential out of logs and source control.
3. Merge the workflow. From GitHub Actions, select Fixture refresh, Run workflow, and mode `refresh`. The default mode `check` only checks feed access. Both feeds must pass before a production refresh starts. No database migrations run.
4. Verify the run succeeds, the public `/api/fixtures` timestamp advances and `/api/results` reflects completed fixtures and both providers' retained predictions. Existing database transactions serialize writes; repeated runs preserve one result per fixture/provider.
5. Set repository Actions variable `FIXTURE_REFRESH_ENABLED` to `true`. Only then are scheduled runs enabled.
6. Remove only `/api/cron/fixtures` from `vercel.json` in a follow-up change after that verification. Until then the Vercel schedule is deliberately retained. Keep all prediction schedules.

The daily schedule is 05:30 UTC, which is 06:30 London during British Summer Time and 05:30 during GMT. GitHub may delay scheduled runs and can replace an older pending run in a concurrency group. Refresh jobs never run simultaneously; already running jobs are not cancelled. Public repositories can have schedules disabled after prolonged inactivity, so monitor successful refreshes.

## Monitoring and manual recovery

Enable GitHub Actions failure notifications in your GitHub notification settings. The user who starts a manual run, or is responsible for a scheduled workflow, should check failed-run notifications. Failed checks or refreshes fail the workflow and remain visible in its run history. Subscribe to Actions notifications for this repository. No email or Slack credentials are required.

The app displays a warning on Predictions and Results when the last successful refresh is over 24 hours old, or its timestamp is unavailable. A failed feed request or transaction does not advance that timestamp or erase retained data. Transient HTTP failures use the existing bounded retry policy; HTTP 403 is not retried repeatedly.

To recover, use Run workflow with mode `refresh` once access is available. For rollback, set `FIXTURE_REFRESH_ENABLED` to `false` and restore the Vercel fixture cron only if its feed access works. The original authenticated Vercel refresh endpoint remains available. Neither recovery route regenerates forecasts.
