# Competition and scoring verification

The competition remains disabled until its activation and fixture boundary are explicitly agreed. The Results API reports `active: false` and a null included-fixture boundary; historical and per-match O Scores are diagnostics, not competition rankings. Reading results never calls a prediction provider.

## Deployment and verification

The O Score and summary-view changes use the existing PostgreSQL JSON fields and require no new schema migration. The existing checksummed `003-five-agents` migration must be applied by the Vercel `npm run db:migrate` build command before the five-agent functions are deployed. Configure the server-only provider keys and validated Neon settings described in [prediction agents](prediction-agents.md) and [Neon migration](neon-migration.md), then deploy through that build. The weekly prediction cron remains configured in `vercel.json`; keep the competition disabled independently of that schedule.

For a release check, run `npm ci`, then `npm test`. Set `TEST_DATABASE_URL` to an isolated PostgreSQL test database to run the persistence and API integration suite; tests create and remove their own schema. The integrated five-provider test uses mocked adapters, verifies identical saved fixture evidence, missing and mean-assigned O Scores, corrected actual results, disabled competition metadata, and provider-free Results reads. Do not point tests or previews at the production database.

The complete local suite passed 167 tests with no skips against isolated PostgreSQL 14.17. CI separately provisions PostgreSQL 17. The database version used locally is not the production database.

On 24 October 2026, authenticated metadata-only GETs returned HTTP 200 and listed each configured target: Jev through Vercel AI Gateway (`typesafe-ai/jev`), Decisions API (`gpt-6-luna`) and ChatGPT (`gpt-6.1-sol`) through OpenAI's model list, Claude (`claude-haiku-5-5`), and Gemini (`gemini-3.1-flash-lite`). The four required environment-variable names were present in the ignored local configuration; credential values were not displayed or recorded. These zero-token metadata checks confirm endpoint access and model listing only. They do not verify generation adapter request formats, generation permission, quota, latency, or cost. Forecast generation is the first operation that can consume model tokens; this verification makes no generation calls.

Usage and cost remain uncertain until actual forecast responses are collected. Use the existing attempt usage and cost metadata described in [prediction agents](prediction-agents.md); Jev's cost remains unknown when the provider does not return a usable cost figure. No paid generation call was made for this verification.

## Browser check

Desktop and mobile checks used a local preview backed by the fixture and Results API payloads produced by the isolated PostgreSQL run. The initial Results request intentionally returned a preview-only error; the page showed the unavailable competition-status message and a retry control, then cleared its error states and rendered the API response after retry. Results showed the all-missing match without fabricated forecasts or scores, fractional mean-assigned scores, full-history totals, and historical gameweek counts while competition remained disabled.

At widths 600, 761, 780, 820, 821, 1101, 1199 and 1200 pixels, document width matched the viewport and the forecast row content fit inside each card. Fixture cards switch to one column through 820px, two columns from 821px through 1199px, then three columns at 1200px where each card has enough room for its forecast rows. The 600px check included expanded Details content. Search and gameweek filtering were also exercised; Results pagination and the 21-match API paging path are covered by the PostgreSQL suite.

The approved stacked merge order is PR #32, then #33, #34, #35, and finally the verification PR for issue #29. PRs must remain ready and unmerged until explicitly authorized; the competition boundary and activation remain deferred.
