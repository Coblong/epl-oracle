import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fingerprint} from './migration.mjs';

export async function predictFixtures(store, targets, predict, wait = delay) {
  const predictions = await store.getPredictions();
  const invocation = randomUUID();
  let updated = 0, failed = 0;
  for (const match of targets) {
    const matchSignature = JSON.stringify(match);
    if (predictions[match.id]?.matchSignature === matchSignature) continue;
    try { if (fingerprint(JSON.parse(predictions[match.id]?.matchSignature)) === fingerprint(match)) continue; } catch {}
    // Evidence may return to an earlier state after rescheduling. Each new
    // generation must retain its own revision instead of reusing the old run.
    const run = await store.beginRun(`jev:${match.id}:${fingerprint(match)}:${invocation}`);
    const input = await store.saveSnapshot(run.id, match.id, match);
    const attempt = {runId:run.id, fixtureId:match.id, provider:'jev'};
    await store.recordAttempt({...attempt, status:'started'});
    try {
      const prediction = await predict(input);
      if (await store.savePrediction({...attempt, matchSignature, prediction})) updated++;
      else await store.recordAttempt({...attempt, status:'failed', error:'Fixture changed during prediction.'});
    } catch (error) {
      console.error(`Prediction failed for fixture ${match.id}:`, error.message);
      failed++;
      await store.recordAttempt({...attempt, status:'failed', error:'Provider prediction failed.'});
    }
    await wait(300);
  }
  return {updated, failed};
}
