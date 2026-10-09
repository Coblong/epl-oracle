import {createHash} from 'node:crypto';
import {accuracySummary, evaluatePrediction} from './football.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function validPrediction(p) {
  const probabilities = p?.probabilities;
  return ['home', 'draw', 'away'].includes(p?.outcome) && Array.isArray(p.score) && p.score.length === 2 && p.score.every(v => Number.isInteger(v) && v >= 0 && v <= 6)
    && Number.isFinite(Date.parse(p.generatedAt)) && typeof p.model === 'string'
    && ['home', 'draw', 'away'].every(k => Number.isFinite(probabilities?.[k]) && probabilities[k] >= 0 && probabilities[k] <= 1)
    && Math.abs(probabilities.home + probabilities.draw + probabilities.away - 1) <= 0.02;
}

export function inspectSnapshot(snapshot) {
  const {fixtures, predictions, results} = snapshot;
  if (!fixtures || !Array.isArray(fixtures.matches) || typeof fixtures.source !== 'string' || !Number.isFinite(Date.parse(fixtures.updatedAt))
    || !predictions || Array.isArray(predictions) || typeof predictions !== 'object' || !Array.isArray(results)) throw new Error('Invalid or missing migration source documents.');
  const identities = new Set();
  for (const f of [...fixtures.matches, ...results]) {
    if (!Number.isInteger(f.id) || !f.home || !f.away) throw new Error('Invalid fixture identity in migration source.');
    identities.add(f.id);
  }
  if (new Set(fixtures.matches.map(f => f.id)).size !== fixtures.matches.length || new Set(results.map(r => r.id)).size !== results.length) throw new Error('Duplicate fixtures or results in migration source.');
  if (results.some(r => fixtures.matches.some(f => f.id === r.id))) throw new Error('Fixture appears in both upcoming and completed source data.');
  for (const [id, entry] of Object.entries(predictions)) {
    if (!/^[1-9]\d*$/.test(id) || !identities.has(Number(id)) || !validPrediction(entry?.prediction) || typeof entry.matchSignature !== 'string') throw new Error('Invalid or orphaned prediction in migration source.');
  }
  for (const r of results) {
    if (!validPrediction(r.prediction) || !Array.isArray(r.actualScore) || r.actualScore.length !== 2 || !r.actualScore.every(v => Number.isInteger(v) && v >= 0)) throw new Error('Invalid completed prediction or score in migration source.');
    const expected = evaluatePrediction(r.prediction, ...r.actualScore);
    if (r.correctOutcome !== expected.correctOutcome || r.correctScore !== expected.correctScore || r.actualOutcome !== expected.actualOutcome) throw new Error('Source result correctness flags disagree with the actual score.');
  }
  return {digest: fingerprint(snapshot), fixtures: identities.size, upcoming: fixtures.matches.length, activePredictions: Object.keys(predictions).length,
    predictionVersions: Object.keys(predictions).length + results.length, results: results.length, summary: accuracySummary(results)};
}

// Reads bypass Blob's CDN cache. Repeated identical passes detect active writers;
// pause legacy cron jobs during the final export to ensure a coherent baseline.
export async function captureSnapshot(read) {
  const capture = async () => ({fixtures: await read('data/fixtures.json'), predictions: await read('data/predictions.json', {}), results: await read('data/results.json', [])});
  let previous = await capture();
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await capture();
    if (fingerprint(previous) === fingerprint(next)) { inspectSnapshot(next); return next; }
    previous = next;
  }
  throw new Error('Blob changed during export. Pause legacy writers and retry.');
}
