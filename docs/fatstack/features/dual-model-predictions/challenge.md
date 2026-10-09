# Dual model predictions: challenge

## Idea

Show Jev and OpenAI Decisions API predictions for upcoming Premier League fixtures, giving visitors two opinions. Refresh forecasts weekly, show actual results, and track each provider's performance.

## Shared understanding

Every Wednesday at 09:00 Europe/London, generate predictions from both providers for fixtures kicking off within the next ten days. Both providers use the same saved input for that week's fixture forecast. Refresh eligible fixtures each Wednesday even if their statistics have not changed, preserve prediction history, and display each provider's latest successful forecast and timestamp.

Refresh fixtures and actual results daily. Provide Upcoming and Results views in the fixture section. Completed fixtures show the actual score beside both providers' final forecasts, with separate highlights for correct outcomes and exact scores. The track record shows each provider's full history and a comparison restricted to fixtures both predicted.

Move application persistence from Vercel Blob JSON files to Neon Postgres. Import existing Jev predictions and results, verify the migrated totals, and retain the original Blob files for rollback. Store fixtures, prediction runs and their input snapshots, prediction revisions, and attempt status. Use constraints and transactions to make retries and overlapping jobs safe.

## Confirmed

- The purpose is to display two opinions, rather than establish a single best football forecasting model.
- Add OpenAI Decisions API forecasts alongside Jev forecasts for each eligible fixture.
- Generate forecasts weekly on Wednesday at 09:00 Europe/London, accounting for daylight saving.
- Forecast fixtures kicking off within the next ten days. Exclude fixtures without a kickoff date from prediction generation.
- Run both providers again for every eligible fixture each Wednesday, including fixtures already predicted in an overlapping window and fixtures whose statistics have not changed.
- Supply both providers with the same saved fixture input for that weekly run.
- Show each provider's latest successful forecast and its timestamp.
- Preserve previous prediction versions. Score the latest successful prediction made before kickoff for each provider.
- Retain an older successful prediction when a provider refresh fails. Show its date and the failed refresh explicitly.
- Save successful provider predictions immediately and retry failures within a bounded Wednesday morning window using that morning's saved input. A retry must not replace an already successful prediction for that run.
- Continue daily fixture and actual-result updates independently of weekly prediction generation.
- Keep outcome and exact-score predictions separate, even when they disagree. Evaluate and highlight correctness separately.
- Provide Upcoming and Results views in the fixture section. Results show actual scores alongside both final forecasts.
- Extend the aggregate track record to both providers, including sample counts, outcome accuracy, exact-score accuracy, and Brier score for outcome probabilities.
- Show each provider's full history and a comparison restricted to fixtures both providers predicted. Existing Jev history remains part of its full history.
- Retain forecasts for postponed fixtures, mark them postponed or awaiting a date, and refresh them when the revised kickoff enters a Wednesday prediction window.
- Exclude cancelled fixtures from accuracy totals.
- Migrate persistence to Neon Postgres as part of this addition.
- Import existing Jev predictions and results, verify totals, and retain original Blob files for rollback. Previously overwritten prediction versions cannot be recovered from the current files.

## Assumptions

- Continue using current-season statistics and the five most recent completed matches as forecast evidence. Adding injury, lineup, or betting data is outside this addition.
- Keep the existing home/draw/away question and exact-score choices of zero to six goals per team for both providers.
- Initially use `gpt-6-luna` for OpenAI Decisions, subject to verification during implementation, and label the provider and actual model used.
- Fixtures outside the prediction window can remain visible with a pending-prediction state.
- Use fixtures, prediction runs, predictions, and attempts as the initial storage concepts. The final database schema will be specified during requirements and implementation.

## Open questions

- Define the exact ten-day boundary, including whether the final instant is inclusive and whether days mean elapsed hours or London calendar days.
- Define the Wednesday morning retry cutoff, backoff, and recovery behaviour if the scheduled run never starts.
- Determine how to show feed states for postponements and cancellations when the official fixture feed does not explicitly provide those distinctions.
- Determine the treatment of a postponed fixture whose prior kickoff has already passed, including which prediction deadline applies after rescheduling.
- Define the Brier score convention and denominator consistently for full history and shared-fixture comparisons.
- Define the Results view's pagination and retention presentation.
- Confirm Neon provisioning, database region, credentials, and the production migration and cutover procedure.
- Verify the latest Decisions API schema, limits, and model availability, and configure its server-only credential.

## Edge cases

- A fixture appears in two Wednesday windows: refresh both providers on each Wednesday, preserve previous versions, and score the latest successful pre-kickoff version. (confirmed)
- Statistics are unchanged since the previous Wednesday: call both providers again for eligible fixtures. (confirmed)
- One provider succeeds and the other fails: persist the success, retry only the failed provider using the saved input, and show any remaining missing or older forecast explicitly. (confirmed)
- A failed refresh has an older successful forecast: retain it with its timestamp and failed-refresh status. (confirmed)
- A provider fails without any previous forecast: show the missing forecast explicitly and exclude it from that provider's resolved prediction count. (assumed)
- Outcome and scoreline disagree: display both, with independent outcome and exact-score correctness. (confirmed)
- A fixture has no kickoff date: do not generate a forecast until it has a date within the window. (confirmed)
- A fixture is postponed: retain its forecasts, display its status, and refresh when the revised kickoff is eligible. (confirmed)
- A fixture is cancelled: exclude it from accuracy totals. (confirmed)
- A fixture finishes: show the actual score and evaluate the latest successful pre-kickoff forecast for each provider independently. (confirmed)
- A fixture finishes with a prediction from only one provider: include it in that provider's full history, but exclude it from the shared-fixture comparison. (confirmed)
- A Wednesday run is duplicated or overlaps another job: use database constraints and transactions to prevent duplicate successful predictions or lost updates. (confirmed)
- A request starts before kickoff but completes after kickoff: determine whether it is eligible for display and scoring. (open)
- A scheduled run is missed entirely: recovery behaviour remains to be specified. (open)
- The fixture feed fails: whether weekly forecasts should proceed using older fixture data remains to be specified. (open)
- An official result is corrected later: determine whether to update stored results and recalculate track records. (open)
- Existing Jev records have no corresponding OpenAI prediction: preserve them in Jev's full history and exclude them from the shared-fixture comparison. (confirmed)
- Migration cannot reconstruct older Jev revisions: preserve available records without inventing missing history. (confirmed)
- Database migration validation fails: do not cut over; retain Blob data for rollback. (assumed)
