import {buildFixtures} from '../../lib/football.mjs';
import {jsonFetch} from '../../lib/http.mjs';
import {getStore} from '../../lib/store.mjs';
import {authorizeCron} from '../../lib/cron-auth.mjs';

const json = (res, status, data) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
};

export default async function handler(req, res) {
  if (!authorizeCron(req)) return json(res, 401, {error: 'Unauthorized'});
  const updatedAt = new Date().toISOString();
  try {
    const [raw, bootstrap] = await Promise.all([
      jsonFetch('https://fantasy.premierleague.com/api/fixtures/'),
      jsonFetch('https://fantasy.premierleague.com/api/bootstrap-static/'),
    ]);
    if (!Array.isArray(raw) || !Array.isArray(bootstrap.teams)) throw new Error('Invalid fixture feed');

    const matches = buildFixtures(raw, bootstrap.teams);
    const result = await getStore().refreshFixtures({matches, raw, teams:bootstrap.teams, source:'Official Fantasy Premier League', updatedAt});
    return json(res, 200, {ok:true, fixtures:matches.length, ...result});
  } catch (e) {
    console.error(e);
    return json(res, 502, {error:'Unable to refresh fixtures. Check server configuration and retry.'});
  }
}
