import {put, get} from '@vercel/blob';
import {evaluatePrediction, teamRef} from './football.mjs';

export async function readJSON(pathname, fallback = null) {
  const result = await get(pathname, {access:'public'});
  if (!result) return fallback;
  return JSON.parse(await new Response(result.stream).text());
}
export async function writeJSON(pathname, data) {
  await put(pathname, JSON.stringify(data), {access:'public', contentType:'application/json', addRandomSuffix:false, allowOverwrite:true});
}

// Original backend for pre-cutover operation and rollback. Whole-document writes
// retain the original concurrency limits; Neon uses transactional row writes.
export function createBlobStore({read = readJSON, write = writeJSON} = {}) {
  let predictions;
  const store = {
    getFixtures: () => read('data/fixtures.json'),
    async getPredictions() { predictions = await read('data/predictions.json', {}); return predictions; },
    getResults: () => read('data/results.json', []),
    async getFixtureView() { return {fixtures:await store.getFixtures(), predictions:await store.getPredictions()}; },
    async beginRun(runKey) { return {id:runKey}; },
    async saveSnapshot(runId, fixtureId, input) { return input; },
    async recordAttempt() {},
    async savePrediction({fixtureId, matchSignature, prediction, provider = 'jev'}) {
      if (provider !== 'jev') throw new Error('Dual-provider predictions require Neon persistence.');
      // Retain this invocation's successful writes even if the public URL keeps
      // serving the pre-run document. Publish only after a write succeeds.
      if (!predictions) await store.getPredictions();
      const next = {...predictions, [fixtureId]:{matchSignature, prediction}};
      await write('data/predictions.json', next);
      predictions = next;
      return true;
    },
    async refreshFixtures({matches, raw, teams, source, updatedAt}) {
      const currentPredictions = await store.getPredictions(), results = await store.getResults();
      const byId = new Map(raw.map(f=>[f.id,f])), resolvedIds = new Set(results.map(r=>r.id)), upcomingIds = new Set(matches.map(m=>m.id));
      const remaining = {}, added = [];
      for (const [key, entry] of Object.entries(currentPredictions)) {
        const id = Number(key), f = byId.get(id);
        if (f?.finished && Number.isInteger(f.team_h_score) && Number.isInteger(f.team_a_score)) {
          if (!resolvedIds.has(id)) added.push({id, gameweek:f.event, kickoff:f.kickoff_time, home:teamRef(teams,f.team_h), away:teamRef(teams,f.team_a), prediction:entry.prediction,
            ...evaluatePrediction(entry.prediction,f.team_h_score,f.team_a_score), evaluatedAt:updatedAt});
        } else if (upcomingIds.has(id)) remaining[key] = entry;
      }
      await write('data/fixtures.json', {matches,source,updatedAt});
      await write('data/predictions.json', remaining);
      predictions = remaining;
      if (added.length) await write('data/results.json', [...results,...added]);
      return {resolved:added.length};
    },
  };
  return store;
}
