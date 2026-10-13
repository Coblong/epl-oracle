import {buildFixtures,validateTeamCatalog} from './football.mjs';
import {jsonFetch} from './http.mjs';

const ROOT='https://fantasy.premierleague.com/api/';
export function validateFixtureFeed(raw) {
  const seen=new Set();
  if(!Array.isArray(raw) || !raw.length)throw new Error('Invalid fixture feed');
  for(const f of raw){
    if(!f || !Number.isSafeInteger(f.id) || f.id<1 || seen.has(f.id)
      || !Number.isSafeInteger(f.team_h) || !Number.isSafeInteger(f.team_a) || f.team_h===f.team_a
      || f.kickoff_time!==null && !Number.isFinite(Date.parse(f.kickoff_time))
      || ['team_h_score','team_a_score'].some(key=>f[key]!==null && (!Number.isInteger(f[key]) || f[key]<0)))throw new Error('Invalid fixture feed');
    seen.add(f.id);
  }
  return raw;
}

export async function fetchFixtureData({fetchJson=jsonFetch,now=()=>new Date()}={}) {
  const responses=await Promise.allSettled([
    fetchJson(`${ROOT}fixtures/`).then(data=>({data,updatedAt:now().toISOString()})),
    fetchJson(`${ROOT}bootstrap-static/`).then(data=>({data,updatedAt:now().toISOString()})),
  ]);
  if(responses[0].status!=='fulfilled')throw responses[0].reason;
  const fixtures=responses[0].value;
  validateFixtureFeed(fixtures.data);
  return {fixtures,bootstrap:responses[1]};
}

export async function checkFeedAccess(options={}) {
  const {fixtures,bootstrap}=await fetchFixtureData(options);
  if(bootstrap.status!=='fulfilled')throw bootstrap.reason;
  const teams=validateTeamCatalog(bootstrap.value.data?.teams,fixtures.data);
  return {ok:true,fixtures:fixtures.data.length,teams:teams.length};
}

export async function refreshFixtures(store,options={}) {
  const {fixtures,bootstrap}=await fetchFixtureData(options);
  const {data:raw,updatedAt}=fixtures;
  let teams,verifiedTeamCatalog=true,teamCatalogUpdatedAt;
  if(bootstrap.status==='fulfilled' && Array.isArray(bootstrap.value.data?.teams)){
    teams=validateTeamCatalog(bootstrap.value.data.teams,raw);
    teamCatalogUpdatedAt=bootstrap.value.updatedAt;
  }else{
    teams=validateTeamCatalog(await store.getTeamCatalog(),raw);
    verifiedTeamCatalog=false;
    console.warn('FPL team feed unavailable; using the persisted team catalog.');
  }
  const matches=buildFixtures(raw,teams,Date.parse(updatedAt));
  const result=await store.refreshFixtures({matches,raw,teams,source:'Official Fantasy Premier League',updatedAt,verifiedTeamCatalog,teamCatalogUpdatedAt});
  return {ok:true,fixtures:matches.length,updatedAt,...result};
}
