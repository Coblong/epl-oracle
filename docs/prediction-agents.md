# Prediction agents

Issue [#23](https://github.com/Coblong/epl-oracle/issues/23) expands the scheduled job, persistence and read APIs to five agents. The original [weekly prediction requirements](fatstack/features/dual-model-predictions/requirements.md) still govern evidence, eligibility, retries and scoring. The five-agent cards and scoreboard presentation are separate tickets.

## Server configuration

| Stable ID | Display name | Requested model | Credential |
| --- | --- | --- | --- |
| `jev` | Jev | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `openai` | Decisions API | `gpt-6-luna` | `OPENAI_API_KEY` |
| `claude` | Claude | `claude-opus-5-5` | `ANTHROPIC_API_KEY` |
| `chatgpt` | ChatGPT | `gpt-6.1-sol` | `OPENAI_API_KEY` |
| `gemini` | Gemini | `gemini-3.1-pro-preview` | `GEMINI_API_KEY` |

Set these server-only environment variables in the intended Vercel environment, or in an ignored `.env.local` for local development. Keep `PERSISTENCE_BACKEND=neon`, `DATABASE_URL` and an explicit `DATABASE_SCHEMA` configured as described in [Neon setup](neon-migration.md). Use an isolated schema for previews and local work. Neither API responses nor the public agent registry contain credential values.

For Claude, a workspace-scoped key needs no extra setting. A key that is not scoped to a workspace also requires `ANTHROPIC_WORKSPACE_ID`; the adapter sends it as `anthropic-workspace-id`. See [Anthropic authentication](https://platform.claude.com/docs/en/manage-claude/authentication). Gemini sends its key in `x-goog-api-key`, never in the request URL. ChatGPT and Decisions share an OpenAI key but use different endpoints and agent IDs.

Missing credentials remain visible as failed or missing agent states. They do not disable the other agents or create substitute forecasts. Tests use mocked HTTP responses and require no provider keys or paid requests. Provider account access and real-response latency still need an operator smoke test before enabling a new credential in production.

## Requests and limits

All agents receive equivalent evidence from the immutable weekly fixture snapshot. Jev and Decisions receive the existing score choice question. Claude, ChatGPT and Gemini receive that same question and evidence, with a JSON schema for exactly 49 score probabilities. Every agent must return exactly 49 finite values in `[0, 1]`. Jev, Decisions, Claude and ChatGPT require a total within `0.02` of one. Gemini accepts any nonzero total for a complete bounded distribution, normalizes it, and retains the original total for audit. The application then chooses the highest aggregate-probability result and the most likely score within it. It rejects refusals, incomplete responses, missing actual model identity and invalid probabilities.

- Claude uses `POST /v1/messages`, adaptive thinking, `output_config.effort: low`, structured JSON output and `max_tokens: 4096`.
- ChatGPT uses `POST /v1/responses`, `reasoning.effort: low`, strict structured JSON output, `max_output_tokens: 4096` and `store: false`.
- Gemini uses `models/gemini-3.1-pro-preview:generateContent`, one candidate, structured JSON output, `thinkingLevel: MINIMAL` and `maxOutputTokens: 4096`.
- Jev and Decisions retain the existing single fixed-choice evaluation request. They do not request free-form reasoning.

The limits bound generated tokens, including reasoning where the provider includes it in the output budget. A response that hits a limit fails the attempt; limits are not increased automatically. There are no adapter-level HTTP retries. Each provider request has a 30-second timeout.

The Wednesday 09:00 Europe/London start, 240-hour horizon, Thursday 09:00 exclusive recovery deadline, pre-kickoff checks, three-attempt maximum and 15-minute minimum retry interval are unchanged. The existing six concurrent workers commit successful forecasts independently. Atomic claims prevent overlapping workers from repeating successful requests. An abandoned claim can be reclaimed after six minutes and the retry backoff. With 50 requests, six workers require nine request waves, up to roughly 273 seconds at the timeout plus database overhead. Larger windows or slow storage can exceed the 300-second cron limit; the next scheduled invocation recovers unfinished work within the same existing deadline. The cron schedule does not guarantee every possible retry.

## Persistence and API contract

The automatic `003-five-agents` migration expands the allowed result agents and adds `attempt_history`. It uses the existing checksummed migration runner and schema lock. It does not rewrite forecasts, recalculate saved historical evaluations, regenerate predictions or backfill request usage. Historical imports also leave the new audit history empty.

Each new claimed attempt records its status. Completed attempts retain normalized usage, actual returned model and a cost estimate when available, including invalid or refused responses that consumed tokens. A failed response's usage survives a later retry. Forecast revisions retain their generation timestamp, model, probabilities, method, usage and cost. Run snapshots retain the original evidence. Raw provider content, reasoning text and private error text are not recorded in the audit metadata. Interrupted requests may have unknown usage because no response was received.

`agents.mjs` is safe to import in the browser and exports `AGENTS` and `AGENT_IDS`. Both read APIs include `agents` metadata. Existing `predictions`, `forecastStates`, `providersConfigured`, `forecasts` and `providerSummaries` remain keyed by the stable IDs above. The legacy Jev fields remain available. A missing forecast stays absent.

The default shared comparison requires eligible pre-kickoff forecasts from all five agents and identifies the cohort in `sharedComparison.providerIds`. Its Brier denominator requires valid probability evidence from every cohort member. Each agent's full history still includes its older forecasts. `trackRecordSummaries(rows, providerIds)` can explicitly compare a subset, including the original Jev/Decisions pair.

## Usage and price estimates

Rates were checked against official documentation on 25 October 2026. Amounts are USD estimates for the standard direct API tier, marked `estimated: true` and dated with `ratesAsOf`. They are not billing records or claims about an account's free tier, negotiated prices or discounts.

| Agent | Input per million tokens | Cached input | Output, including billed reasoning |
| --- | --- | --- | --- |
| Decisions API | $0.10 | $0.01 | $0 |
| Claude Opus 5.5 | $4.00 | $0.20 | $20.00 |
| ChatGPT | $2.00 | $0.10 | $10.00 |
| Gemini 3.1 Pro Preview (prompts ≤200k) | $2.00 | $0.20 | $12.00 |
| Gemini 3.1 Pro Preview (prompts >200k) | $4.00 | $0.40 | $18.00 |

Claude Opus 5.5 uses standard rates across its 1M-token context window; its cache reads cost $0.20 per million tokens, and cache writes cost $5.00 (5-minute) or $8.00 (1-hour) per million. OpenAI estimates are limited to prompts up to 100,000 tokens. Gemini selects its rate tier by total prompt tokens and adds thinking tokens to candidate tokens for the output estimate; OpenAI and Claude already include billed reasoning in output usage. Requests with cache writes, unknown models or unavailable input/output usage have no cost estimate. Cache-write token counts are retained. Jev usage is retained when returned, but its cost remains unknown.

Sources: [Claude Opus 5.5 model and pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [OpenAI reasoning and output budgets](https://developers.openai.com/api/docs/guides/reasoning), [Decisions pricing and usage](https://developers.openai.com/api/docs/guides/decisions), [Gemini 3.1 Pro pricing](https://ai.google.dev/gemini-api/docs/pricing), [Gemini generation API](https://ai.google.dev/api/generate-content).

## Verification

Run `npm ci`, then `npm test` using Node 22 or newer. Set `TEST_DATABASE_URL` to an isolated PostgreSQL database to enable the integration tests; without it those tests are skipped. Tests cover adapter request/response contracts, malformed output, missing credentials, timeouts and rate limits, the actual five-agent cron path, retry isolation, shared evidence, independent commits, historical preservation, migration idempotence, result evaluation and Brier cohorts. CI runs the suite with PostgreSQL 17.
