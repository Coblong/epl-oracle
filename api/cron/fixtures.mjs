import {refreshFixtures} from '../../lib/fixture-refresh.mjs';
import {getStore} from '../../lib/store.mjs';
import {authorizeCron} from '../../lib/cron-auth.mjs';

const json = (res, status, data) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
};

export default async function handler(req, res) {
  if (!authorizeCron(req)) return json(res, 401, {error: 'Unauthorized'});
  try {
    return json(res, 200, await refreshFixtures(getStore()));
  } catch (e) {
    console.error(e);
    return json(res, 502, {error:'Unable to refresh fixtures. Check server configuration and retry.'});
  }
}
