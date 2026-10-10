# Dual model predictions: requirements

Source: [Challenge record](challenge.md), reviewed in conversation on 9 October 2026.
Decisions: the product owner confirmed the scheduling defaults for issue #3 and the provider retry cutoff on 10 October 2026; see R2, R3 and R8 below.

## Summary

Visitors want Jev and OpenAI Decisions API opinions on upcoming Premier League fixtures. Both providers will refresh forecasts weekly using the same evidence. Completed fixtures will show actual results and each provider's correctness, with aggregate track records. Neon Postgres will preserve forecasts, revisions and results while supporting safe retries.

## User stories

1. As a visitor, I want both providers' forecasts for a fixture so I can see their opinions.
2. As a visitor, I want actual results beside the forecasts so I can see which predictions were correct.
3. As a visitor, I want both providers' track records so I can understand their past performance.
4. As an operator, I want scheduled updates, safe retries and retained history so failures do not erase successful forecasts.
5. As an operator, I want existing data migrated safely so the application retains its Jev history.

## Requirements

- **R1** (confirmed): For every eligible fixture, request predictions from Jev and OpenAI Decisions API. Display their forecasts separately. Stories: 1
- **R2** (confirmed): Start prediction generation every Wednesday at 09:00 Europe/London, accounting for daylight saving. Daily fixture and result refreshes must operate independently. If the scheduled start is missed, recover the same weekly run until Thursday 09:00 Europe/London. Stories: 1, 2, 4
- **R3** (confirmed): Select unstarted fixtures with a dated kickoff in the half-open interval from the scheduled Wednesday 09:00 Europe/London instant through, but not including, the instant exactly 240 hours later. Do not predict undated fixtures. Stories: 1, 4
- **R4** (confirmed): Refresh both providers for all eligible fixtures each Wednesday, including previously predicted fixtures and fixtures whose statistics have not changed. Stories: 1
- **R5** (confirmed): Save a shared input snapshot for each fixture's weekly run. Both providers and retries must use that snapshot. Stories: 1, 4
- **R6** (confirmed): Display each provider's latest successful prediction and its generation timestamp. Preserve earlier prediction versions. Stories: 1, 4
- **R7** (confirmed): Persist each successful provider prediction immediately. Failure by another provider must not discard it. Stories: 4
- **R8** (confirmed): Retry failed predictions before the weekly run's recovery deadline, Thursday 09:00 Europe/London, exclusive. Do not regenerate an already successful prediction for that run. Stories: 4
- **R9** (confirmed): When a refresh fails, retain any older successful prediction and show its date and failed-refresh status. When no prediction exists, explicitly show that it is missing. Stories: 1, 4
- **R10** (confirmed): Preserve separate outcome and exact-score forecasts, even when they disagree. Evaluate and highlight correct outcomes and exact scores independently. Stories: 1, 2
- **R11** (confirmed): Provide Upcoming and Results views in the fixture section. Completed fixtures must show the actual score alongside both providers' final forecasts. Stories: 1, 2
- **R12** (confirmed): For each completed fixture and provider, evaluate the latest successful prediction made before kickoff. Earlier revisions must not add extra observations to the track record. Stories: 2, 3
- **R13** (confirmed): Show each provider's full track record with sample counts, outcome accuracy, exact-score accuracy and Brier score for outcome probabilities. Stories: 3
- **R14** (confirmed): Also show a comparison restricted to completed fixtures with eligible predictions from both providers. Preserve existing Jev history in its full track record without inventing corresponding OpenAI predictions. Stories: 3, 5
- **R15** (assumed): A fixture without an eligible prediction for a provider must not count in that provider's resolved prediction denominator. Stories: 3
- **R16** (confirmed): Retain forecasts for postponed fixtures, display their status, and refresh them when their revised kickoff enters a Wednesday prediction window. Stories: 1, 4
- **R17** (confirmed): Exclude cancelled fixtures from accuracy totals. Stories: 3
- **R18** (confirmed): Persist application data in Neon Postgres. Retain fixtures, prediction runs, shared input snapshots, prediction revisions and attempt status. Stories: 4, 5
- **R19** (confirmed): Duplicate or overlapping jobs must not cause duplicate successful predictions for the same fixture, provider and weekly run, lost updates, or partially committed related updates. Use database constraints and transactions. Stories: 4
- **R20** (confirmed): Import available existing Jev predictions and results and verify migrated totals. Retain original Blob files for rollback. Do not fabricate unavailable prediction revisions. Stories: 5
- **R21** (assumed): Do not switch production persistence to Neon if migration validation fails. Stories: 5
- **R22** (assumed): Use current-season statistics and the five most recent completed matches as evidence. Both providers must receive equivalent questions asking for home/draw/away and an exact score from zero to six goals per team. Stories: 1
- **R23** (assumed): Initially use `gpt-6-luna` for Decisions, subject to availability verification. Identify each prediction's provider and actual model used. Stories: 1, 4
- **R24** (assumed): Fixtures outside the prediction window may remain visible with a pending-prediction state. Stories: 1
- **R25** (confirmed): Do not create a new weekly prediction snapshot when the latest official fixture refresh is more than 24 hours old. Reuse an existing run snapshot for any recovery work even when the fixture feed later becomes stale. Stories: 1, 4
- **R26** (confirmed): A provider response completed at or after the fixture kickoff is a failed attempt and must not be saved as a prediction. Stories: 1, 4

## Constraints

- The product's purpose is to offer two opinions. Selecting a single winning model is not its primary objective. (confirmed)
- Prediction generation is weekly; fixture and result updates remain daily. (confirmed)
- Neon replaces Blob as the application's active persistence system. Existing Blob data remains available for migration rollback. (confirmed)
- Earlier Jev versions already overwritten in Blob cannot be reconstructed from the current files. (confirmed)
- Forecasts use full-time results after 90 minutes plus stoppage time. (assumed)
- Provider and database credentials must remain server-side. (assumed)
- The initial storage concepts are fixtures, prediction runs, predictions and attempts; the final schema remains an implementation decision. (assumed)

## Edge cases

- Overlapping ten-day windows or unchanged statistics: refresh both providers and preserve revisions. Requirements: R4, R6. (confirmed)
- One provider succeeds and another fails: retain the success and retry only the failure with the shared snapshot. Requirements: R5, R7, R8, R9. (confirmed)
- Failed refresh with an older forecast: retain and label the older forecast. Requirement: R9. (confirmed)
- Failure without an older forecast: show a missing prediction and omit it from that provider's scoring denominator. Requirements: R9, R15. (assumed)
- Contradictory outcome and scoreline: display and score them separately. Requirement: R10. (confirmed)
- Undated fixture: wait until it has an eligible kickoff date before predicting. Requirement: R3. (confirmed)
- Postponed or cancelled fixture: retain postponed forecasts and refresh when eligible; exclude cancellations from accuracy totals. Requirements: R16, R17. (confirmed)
- Completed fixture with only one provider's forecast: include it in that provider's full history and exclude it from the shared comparison. Requirements: R12, R14. (confirmed)
- Duplicate or overlapping jobs: prevent duplicate successful forecasts and lost updates. Requirement: R19. (confirmed)
- Legacy Jev data without OpenAI equivalents or earlier revisions: preserve available history without inventing records. Requirements: R14, R20. (confirmed)
- Migration validation failure: retain Blob operation and do not cut over. Requirement: R21. (assumed)

## Out of scope

- Making the application choose one provider's opinion as authoritative. (confirmed)
- Adding injury, lineup or betting data to forecast evidence. (assumed)
- Reconstructing unavailable historic forecasts or generating retrospective OpenAI forecasts for existing Jev results. (confirmed)
- A visitor-facing interface for browsing every prediction revision. History will be persisted, but this interface has not been requested. (assumed)

## Open questions

- What backoff should provider retries use? Owner: product owner and implementer.
- Should forecasts proceed using older fixture data when the official feed fails? Owner: product owner.
- How should postponements and cancellations be identified when the feed does not explicitly distinguish them? Owner: implementer, with product owner agreement.
- Which kickoff deadline applies after postponement, particularly when the original kickoff has passed? Owner: product owner.
- Which Brier score convention and denominators should be used? Owner: implementer, with product owner agreement.
- Should later official score corrections update results and recalculate track records? Owner: product owner.
- How should Results pagination and history presentation work? Owner: product owner.
- What are the Neon region, provisioning, credentials and production cutover procedure? Owner: operator and implementer.
- Verify the Decisions API schema, limits and model availability, and configure its server-only credential. Owner: implementer and operator.

## Tickets

- [#1: Migrate existing Jev data and application persistence to Neon](https://github.com/Coblong/epl-oracle/issues/1) — R18–R20 (confirmed), R21 (assumed).
- [#2: Show both providers' forecasts with retained prediction history](https://github.com/Coblong/epl-oracle/issues/2) — R1, R5–R7, R10 forecast display (confirmed), R22–R23 (assumed).
- [#3: Generate forecasts every Wednesday for the next ten days](https://github.com/Coblong/epl-oracle/issues/3) — R2–R6, R19, R25–R26 (confirmed), R24 (assumed).
- [#4: Retry failed forecasts while retaining older opinions](https://github.com/Coblong/epl-oracle/issues/4) — R7–R9, R19 (confirmed).
- [#5: Show actual results and highlight correct forecasts](https://github.com/Coblong/epl-oracle/issues/5) — R10–R12, R16–R17 (confirmed).
- [#6: Extend the track record to both providers](https://github.com/Coblong/epl-oracle/issues/6) — R12–R14, R17 (confirmed), R15 (assumed).
