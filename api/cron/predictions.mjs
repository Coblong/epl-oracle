import {setTimeout as delay} from 'node:timers/promises';
import {readJSON, writeJSON} from '../../lib/store.mjs';
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
    const fixtures = await readJSON('data/fixtures.json');
    if (!fixtures) return json(res, 409, {error: 'Fixtures have not been loaded yet.'});

    const now = Date.now();
    const upcoming = fixtures.matches.filter(m => !m.kickoff || Date.parse(m.kickoff) > now);
    const nextGameweek = upcoming[0]?.gameweek;
    const targets = upcoming.filter(m => m.gameweek === nextGameweek);

    const predictions = (await readJSON('data/predictions.json')) || {};
    let updated = 0, failed = 0;
    for (const match of targets) {
      const matchSignature = JSON.stringify(match);
      if (predictions[match.id]?.matchSignature === matchSignature) continue;
      try {
        const prediction = await predictMatch(match);
        predictions[match.id] = {matchSignature, prediction};
        await writeJSON('data/predictions.json', predictions);
        updated++;
      } catch (e) {
        console.error(`Prediction failed for fixture ${match.id}:`, e.message);
        failed++;
      }
      await delay(300);
    }

    return json(res, 200, {ok: true, gameweek: nextGameweek ?? null, targeted: targets.length, updated, failed});
  } catch (e) {
    console.error(e);
    return json(res, 502, {error: e.message});
  }
}
