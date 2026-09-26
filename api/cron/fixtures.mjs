import {buildFixtures, teamRef, evaluatePrediction} from '../../lib/football.mjs';
import {jsonFetch} from '../../lib/http.mjs';
import {readJSON, writeJSON} from '../../lib/store.mjs';
import {authorizeCron} from '../../lib/cron-auth.mjs';

const json = (res, status, data) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
};

export default async function handler(req, res) {
  if (!authorizeCron(req)) return json(res, 401, {error: 'Unauthorized'});
  try {
    const [raw, bootstrap] = await Promise.all([
      jsonFetch('https://fantasy.premierleague.com/api/fixtures/'),
      jsonFetch('https://fantasy.premierleague.com/api/bootstrap-static/'),
    ]);
    if (!Array.isArray(raw) || !Array.isArray(bootstrap.teams)) throw new Error('Invalid fixture feed');

    const matches = buildFixtures(raw, bootstrap.teams);
    const rawById = new Map(raw.map(f => [f.id, f]));

    const predictions = (await readJSON('data/predictions.json')) || {};
    const results = (await readJSON('data/results.json')) || [];
    const alreadyResolved = new Set(results.map(r => r.id));
    const upcomingIds = new Set(matches.map(m => m.id));

    const remainingPredictions = {};
    const newResults = [];
    for (const [idKey, entry] of Object.entries(predictions)) {
      const id = Number(idKey);
      const fixture = rawById.get(id);
      const finished = fixture?.finished && Number.isInteger(fixture.team_h_score) && Number.isInteger(fixture.team_a_score);
      if (finished) {
        if (!alreadyResolved.has(id)) {
          newResults.push({
            id,
            gameweek: fixture.event,
            kickoff: fixture.kickoff_time,
            home: teamRef(bootstrap.teams, fixture.team_h),
            away: teamRef(bootstrap.teams, fixture.team_a),
            prediction: entry.prediction,
            ...evaluatePrediction(entry.prediction, fixture.team_h_score, fixture.team_a_score),
            evaluatedAt: new Date().toISOString(),
          });
        }
      } else if (upcomingIds.has(id)) {
        remainingPredictions[idKey] = entry;
      }
    }

    await writeJSON('data/fixtures.json', {
      matches,
      source: 'Official Fantasy Premier League',
      updatedAt: new Date().toISOString(),
    });
    await writeJSON('data/predictions.json', remainingPredictions);
    if (newResults.length) await writeJSON('data/results.json', [...results, ...newResults]);

    return json(res, 200, {ok: true, fixtures: matches.length, resolved: newResults.length});
  } catch (e) {
    console.error(e);
    return json(res, 502, {error: e.message});
  }
}
