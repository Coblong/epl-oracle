import {getStore} from '../../lib/store.mjs';
import {predictFixtures} from '../../lib/prediction-job.mjs';
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

    // Keep daily changed-evidence Jev behaviour until the weekly-run issue.
    const {updated, failed} = await predictFixtures(store, targets, predictMatch);

    return json(res, 200, {ok: true, gameweek: nextGameweek ?? null, targeted: targets.length, updated, failed});
  } catch (e) {
    console.error(e);
    return json(res, 502, {error:'Unable to generate predictions. Check server configuration and retry.'});
  }
}
