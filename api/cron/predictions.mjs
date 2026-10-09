import {setTimeout as delay} from 'node:timers/promises';
import {getStore} from '../../lib/store.mjs';
import {fingerprint} from '../../lib/migration.mjs';
import {authorizeCron} from '../../lib/cron-auth.mjs';
import {predictMatch} from '../../lib/jev.mjs';

const json = (res, status, data) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
};

export default async function handler(req, res) {
  if (!authorizeCron(req)) return json(res, 401, {error: 'Unauthorized'});
  if (!process.env.AI_GATEWAY_API_KEY) return json(res, 200, {ok: true, skipped: 'AI_GATEWAY_API_KEY is not configured.'});
  try {
    const store = getStore();
    const fixtures = await store.getFixtures();
    if (!fixtures) return json(res, 409, {error: 'Fixtures have not been loaded yet.'});

    const now = Date.now();
    const upcoming = fixtures.matches.filter(m => !m.kickoff || Date.parse(m.kickoff) > now);
    const nextGameweek = upcoming[0]?.gameweek;
    const targets = upcoming.filter(m => m.gameweek === nextGameweek);

    const predictions = await store.getPredictions();
    let updated = 0, failed = 0;
    for (const match of targets) {
      const matchSignature = JSON.stringify(match);
      if (predictions[match.id]?.matchSignature === matchSignature) continue;
      try { if (fingerprint(JSON.parse(predictions[match.id]?.matchSignature)) === fingerprint(match)) continue; } catch {}
      // Keep the daily changed-evidence Jev behaviour for issue 1. Weekly runs
      // and a second provider are delivered by subsequent issues.
      const run = await store.beginRun(`jev:${match.id}:${fingerprint(match)}`);
      const input = await store.saveSnapshot(run.id, match.id, match);
      const attempt = {runId:run.id, fixtureId:match.id, provider:'jev'};
      await store.recordAttempt({...attempt, status:'started'});
      try {
        const prediction = await predictMatch(input);
        if (await store.savePrediction({...attempt, matchSignature, prediction})) updated++;
        else await store.recordAttempt({...attempt, status:'failed', error:'Fixture changed during prediction.'});
      } catch (e) {
        console.error(`Prediction failed for fixture ${match.id}:`, e.message);
        failed++;
        await store.recordAttempt({...attempt, status:'failed', error:'Provider prediction failed.'});
      }
      await delay(300);
    }

    return json(res, 200, {ok: true, gameweek: nextGameweek ?? null, targeted: targets.length, updated, failed});
  } catch (e) {
    console.error(e);
    return json(res, 502, {error:'Unable to generate predictions. Check server configuration and retry.'});
  }
}
