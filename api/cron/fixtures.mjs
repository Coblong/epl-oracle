import {buildFixtures,validateTeamCatalog} from '../../lib/football.mjs';
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
  try {
    const [fixturesResponse,bootstrapResponse] = await Promise.allSettled([
      jsonFetch('https://fantasy.premierleague.com/api/fixtures/').then(data=>({data,updatedAt:new Date().toISOString()})),
      jsonFetch('https://fantasy.premierleague.com/api/bootstrap-static/').then(data=>({data,updatedAt:new Date().toISOString()})),
    ]);
    if (fixturesResponse.status!=='fulfilled') throw fixturesResponse.reason;
    const {data:raw,updatedAt}=fixturesResponse.value;
    if (!Array.isArray(raw)) throw new Error('Invalid fixture feed');

    const store=getStore();
    let teams,verifiedTeamCatalog=true,teamCatalogUpdatedAt;
    if (bootstrapResponse.status==='fulfilled' && Array.isArray(bootstrapResponse.value?.data?.teams)) {
      teams=validateTeamCatalog(bootstrapResponse.value.data.teams,raw);
      teamCatalogUpdatedAt=bootstrapResponse.value.updatedAt;
    } else {
      teams=validateTeamCatalog(await store.getTeamCatalog(),raw);
      verifiedTeamCatalog=false;
      console.warn('FPL bootstrap-static unavailable; using the persisted team catalog.',bootstrapResponse.status==='rejected'?bootstrapResponse.reason?.status:'invalid response');
    }

    const matches = buildFixtures(raw, teams);
    const result = await store.refreshFixtures({matches,raw,teams,source:'Official Fantasy Premier League',updatedAt,verifiedTeamCatalog,teamCatalogUpdatedAt});
    return json(res, 200, {ok:true, fixtures:matches.length, ...result});
  } catch (e) {
    console.error(e);
    return json(res, 502, {error:'Unable to refresh fixtures. Check server configuration and retry.'});
  }
}
