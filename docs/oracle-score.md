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
