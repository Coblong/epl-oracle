import {accuracySummary, evaluatePrediction, matchOutcome} from './football.mjs';

import {AGENT_IDS} from '../agents.mjs';
const outcomes = ['home','draw','away'];

// The multiclass Brier sum is in [0, 2]. Normalize small rounding differences
// accepted by the provider parsers without changing the recorded forecast.
export function outcomeBrier(prediction, actualOutcome) {
  const probabilities = prediction?.probabilities;
  if (!outcomes.includes(actualOutcome) || !outcomes.every(outcome =>
    Number.isFinite(probabilities?.[outcome]) && probabilities[outcome] >= 0 && probabilities[outcome] <= 1)) return null;
  const total = outcomes.reduce((sum,outcome) => sum + probabilities[outcome],0);
  if (Math.abs(total - 1) > 0.02) return null;
  return outcomes.reduce((sum,outcome) => sum + (probabilities[outcome]/total - Number(outcome === actualOutcome)) ** 2,0);
}

function summarize(entries) {
  const scores = entries.map(entry => entry.brier).filter(score => score !== null);
  return {...accuracySummary(entries),brierSampleCount:scores.length,
    brierScore:scores.length ? scores.reduce((sum,score) => sum + score,0)/scores.length : null};
}

// Rows come from the completed-fixture selections made by the result refresh.
// Each fixture/provider key contributes once, irrespective of revision count.
export function trackRecordSummaries(rows, providers = AGENT_IDS) {
  if (!providers.length || new Set(providers).size!==providers.length || providers.some(id=>!AGENT_IDS.includes(id))) throw new Error('Invalid comparison agents.');
  const fixtures = new Map();
  for (const row of rows) {
    if (!providers.includes(row.provider)) continue;
    let forecasts = fixtures.get(row.fixtureId);
    if (!forecasts) fixtures.set(row.fixtureId,forecasts = {});
    const actualOutcome = matchOutcome(...row.actualScore);
    forecasts[row.provider] = {...evaluatePrediction(row.prediction,...row.actualScore),
      brier:outcomeBrier(row.prediction,actualOutcome)};
  }
  const full = Object.fromEntries(providers.map(provider =>
    [provider,summarize([...fixtures.values()].flatMap(forecasts => forecasts[provider] ? [forecasts[provider]] : []))]));
  const paired = [...fixtures.values()].filter(forecasts => providers.every(provider => forecasts[provider]));
  const shared = Object.fromEntries(providers.map(provider => [provider,summarize(paired.map(forecasts => ({
    ...forecasts[provider],
    // Paired Brier scores must have identical probability-evidence denominators.
    brier:providers.every(name => forecasts[name].brier !== null) ? forecasts[provider].brier : null,
  })))]));
  return {providerSummaries:full,sharedComparison:{providerIds:[...providers],resolved:paired.length,providerSummaries:shared}};
}
