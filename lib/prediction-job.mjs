import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fingerprint} from './migration.mjs';

export async function predictFixtures(store, targets, predict, wait = delay) {
  const providers = typeof predict === 'function' ? {jev:predict} : predict;
  const predictions = store.getProviderPredictions ? await store.getProviderPredictions()
    : Object.fromEntries(Object.entries(await store.getPredictions()).map(([id,entry])=>[id,{jev:entry}]));
  const invocation = randomUUID();
  let updated = 0, failed = 0;
  for (const match of targets) {
    const matchSignature = JSON.stringify(match);
    const needed = Object.entries(providers).filter(([provider]) => {
      const entry = predictions[match.id]?.[provider];
      if (entry?.matchSignature === matchSignature) return false;
      try { return fingerprint(JSON.parse(entry?.matchSignature)) !== fingerprint(match); } catch { return true; }
    });
    if (!needed.length) continue;
    // Evidence may return to an earlier state after rescheduling. Each new
    // generation must retain its own revision instead of reusing the old run.
    const run = await store.beginRun(`forecast:${match.id}:${fingerprint(match)}:${invocation}`);
    const input = await store.saveSnapshot(run.id, match.id, match);
    for (const [provider,generate] of needed) {
      const attempt = {runId:run.id, fixtureId:match.id, provider};
      await store.recordAttempt({...attempt, status:'started'});
      try {
        const prediction = await generate(structuredClone(input));
        if (await store.savePrediction({...attempt, matchSignature, prediction})) updated++;
        else await store.recordAttempt({...attempt, status:'failed', error:'Fixture changed during prediction.'});
      } catch (error) {
        console.error(`Prediction failed for fixture ${match.id} (${provider}).`);
        failed++;
        await store.recordAttempt({...attempt, status:'failed', error:'Provider prediction failed.'});
      }
      await wait(300);
    }
  }
  return {updated, failed};
}
