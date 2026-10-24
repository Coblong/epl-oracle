# Oracle score

O Score evaluates an eligible forecast against a completed, confirmed result:

```text
abs(predicted home goals - actual home goals)
+ abs(predicted away goals - actual away goals)
+ 1 when the predicted home/draw/away result is wrong
```

Lower scores are better. Results keep their existing outcome accuracy, exact-score accuracy and Brier measures.

An agent without an eligible pre-kickoff forecast receives the arithmetic mean of the earned O Scores for that match. The mean keeps full precision, and an assigned score never counts as a forecast. If every agent is missing, each score is unavailable. Cancelled matches do not receive O Scores. Official score corrections cause scores and means to be recalculated from the current result and forecasts.

`GET /api/results` includes an `oScores` entry for each agent on each result. Each entry identifies an earned, mean-assigned or unavailable score. Earned entries include separate home-goal error, away-goal error and result penalty fields. Mean-assigned entries have no earned breakdown. The full-history `providerSummaries.<agent>.oScoreDiagnostics` field reports earned count, mean-assigned count, sample count, total and average. Its `scope` is `full_history`; these diagnostics do not activate or rank the competition.

The API reports competition activation as disabled, with no start time or included-fixture boundary. Results do not activate it. Paul will set the start time and boundary when he requests activation.

`GET /api/results` also returns unpaginated gameweek summaries for the current official fixture roster. The roster follows the latest FPL refresh and resets when the season changes. A postponed fixture with no event keeps its last known gameweek; an explicit later event moves it. Cancelled fixtures do not count as remaining and receive no score. A gameweek stays provisional until every non-cancelled fixture has a confirmed result. Historical gameweek statistics remain visible while competition standings are disabled. Accuracy uses eligible forecasts, while the five-agent Brier comparison uses the same fixtures with valid probabilities from all five agents.
