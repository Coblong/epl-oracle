# Neon migration and rollback

The deployment keeps using Blob until `PERSISTENCE_BACKEND=neon` is explicitly configured. `DATABASE_URL` alone does not switch persistence. Neon refuses application access until its import has passed validation. Issue 1 retains daily Jev prediction generation and the existing fixture/results response shapes; weekly forecasts and OpenAI are separate issues.

## Preparation

Use the existing Blob store's `BLOB_READ_WRITE_TOKEN` and Neon's pooled `DATABASE_URL`, with SSL verification enabled, in the server-only environment. London is the agreed Neon region, and the deployment configuration selects London (`lhr1`) for Vercel functions. Never put credentials in source control or migration reports.

The commands below load `.env.local`. Use that file only for the environment being migrated. `DATABASE_SCHEMA` defaults to `epl_oracle`; an isolated preview or test schema can be supplied explicitly. Snapshots are created with owner-only permissions, cannot overwrite an existing filename, and contain application data rather than credentials. Keep them outside the deployed static assets and retain them securely.

## Cutover

1. Deploy this implementation with `PERSISTENCE_BACKEND=blob`. Confirm the existing fixture and track-record views still work.
2. Pause both legacy cron jobs and any manual cron invocations. Wait for in-flight jobs to finish. Keep writers paused throughout export, validation and deployment. Do not rely on the double-read check alone to prove that three independently written Blob files are transactionally consistent.
3. Export an immutable source snapshot to an ignored directory:

   ```sh
   mkdir -p .migration
   node --env-file=.env.local scripts/persistence.mjs export-blob --output .migration/blob-baseline.json
   ```

   The export uses the authenticated Blob metadata and copy APIs to copy each current document to a unique temporary URL, with the source ETag as a copy precondition. It checks the downloaded copy's ETag and the source ETag after reading, then deletes the temporary copy. Public reads of the original URLs can be stale, even with `useCache:false`, so they are never used as migration evidence. The export still requires two identical passes. Missing fixture documents, invalid forecasts, duplicate IDs, orphaned predictions or incorrect result flags fail validation. Temporary copies contain the same public data as the source documents. A failed cleanup aborts the command; remove any remaining `migration-snapshots/` copies before retrying.

4. Review the dry-run report, initialize the database, and import the snapshot:

   ```sh
   node --env-file=.env.local scripts/persistence.mjs import --input .migration/blob-baseline.json
   node --env-file=.env.local scripts/persistence.mjs setup
   node --env-file=.env.local scripts/persistence.mjs import --input .migration/blob-baseline.json --apply
   node --env-file=.env.local scripts/persistence.mjs verify --input .migration/blob-baseline.json
   ```

   The import requires an empty application schema. It commits all source records and the validation marker together, or rolls back everything. The report compares fixture counts, active predictions, prediction revisions, resolved results, correct outcomes and correct scores. Prediction and result payloads are also compared. Reimporting the identical snapshot is safe; a different snapshot cannot overwrite an existing import. Historical completed forecasts have null evidence snapshots where their original input was unavailable.

5. Only after successful validation, set `PERSISTENCE_BACKEND=neon` in Vercel for the target environment and redeploy. Environment changes require a new deployment. Keep the other database and provider settings server-only.
6. Check fixture predictions and track-record totals against the baseline through the deployed API and UI. Resume cron jobs. Observe the next fixture and prediction updates and confirm they are persisted to Neon.

If any validation fails, keep the backend set to Blob and do not resume the cutover. If Blob writers ran after the export, the snapshot is no longer a valid cutover baseline. Export again and import into a fresh Neon branch or empty application schema, rather than forcing an overwrite. Do not delete a schema containing application writes.

## Additive retry schema upgrade

Existing validated Neon schemas need the retry upgrade before the issue #4 application version is deployed. New `setup` commands include it. API reads do not initialize or alter schemas.

1. Pause prediction and fixture writers for the target environment, including manual calls, and wait at least six minutes for in-flight functions to finish. Keep the previous application version serving reads.
2. Check the target `DATABASE_SCHEMA` and private database connection. Use the new code to run the transaction below against that schema:

   ```sh
   node --env-file=.env.local scripts/persistence.mjs upgrade-retries
   ```

   Review [the SQL](../db/upgrade-retries.sql) before running it. It adds attempt counts, next eligibility timestamps, claim tokens and exhausted/expired states. It changes no fixtures, evidence snapshots, successful forecasts, revisions, results or import validation markers. Existing unfinished attempts have unknown total request counts, so the upgrade closes their budgets conservatively. They become expired if their weekly cutoff passed, otherwise exhausted. Counts of zero on legacy rows mean their counts were not recorded. The next weekly run receives a new budget. Repeating the upgrade does not reset counters or close newly recorded attempts.
3. Require the command's `retrySchema.verified` result, then deploy the new version. Verify both provider states and older generation dates through `/api/fixtures` and the fixture cards. Resume the jobs only after verification.

The schema change is additive. The previous application can still read successful forecasts, but its prediction writer does not enforce the new budget. For an application rollback, keep prediction writers paused until a version that enforces the budget is serving them. Retain the added columns and states; do not remove application history or rerun the original import.

## Rollback

Before Neon receives new writes, rollback means setting `PERSISTENCE_BACKEND=blob`, redeploying and resuming cron jobs. The original Blob files have not been changed by the import.

After Neon receives writes, the original Blob files are a point-in-time backup. Simply switching back would discard newer forecasts and results from the displayed application. To preserve current records:

The compatible Blob export contains Jev forecasts only. Once dual predictions are enabled, OpenAI forecasts, shared run evidence and attempt history remain in Neon and cannot be represented in the legacy Blob format. Keep Neon available throughout any rollback; switching to Blob hides the OpenAI opinions. The compatible export is not a full database backup.

1. Pause jobs and wait for in-flight invocations to finish.
2. Preserve the original Blob baseline and export Neon's current compatible fixture/prediction/results view:

   ```sh
   node --env-file=.env.local scripts/persistence.mjs export-neon --output .migration/neon-rollback.json
   node --env-file=.env.local scripts/persistence.mjs restore-blob --input .migration/neon-rollback.json
   ```

3. Review that dry run, then explicitly restore Blob and verify the restored data:

   ```sh
   node --env-file=.env.local scripts/persistence.mjs restore-blob --input .migration/neon-rollback.json --apply
   ```

   Blob restoration writes three documents and is not transactional. Verification uses the same temporary-copy reader as export, so cached public data cannot make an old snapshot appear restored. If restoration or its verification fails, keep jobs paused and repeat restoration from the saved snapshot before switching. Allow the original public URLs' existing cache lifetime to expire before resuming Blob-backed traffic, or continue serving Neon until then. Neon retains the complete revision/run/attempt history; the old Blob format can only represent active forecasts and completed results.

4. Set `PERSISTENCE_BACKEND=blob`, redeploy, verify the API/UI totals, then resume jobs. Keep the Neon database and both snapshots available for investigation.

## Verification

```sh
npm test
TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/DATABASE npm test
```

Without `TEST_DATABASE_URL`, database integration tests are explicitly skipped. With it, tests create a randomly named schema, exercise the real PostgreSQL transactions and API handlers, and delete only that schema afterward. Never pass a connection string as a literal shell command for a remote credential; set it through the private environment instead.

The database checks cover import parity and idempotence, rejection before validation, invalid-source and insert-failure rollback, immutable inputs, retained revisions, attempt status, concurrent writes, final-score resolution, duplicate refreshes and rejection of older fixture data.
