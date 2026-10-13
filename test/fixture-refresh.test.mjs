import test from 'node:test';
import assert from 'node:assert/strict';
import {checkFeedAccess,refreshFixtures,validateFixtureFeed} from '../lib/fixture-refresh.mjs';
import {fixtureFreshness} from '../fixture-freshness.mjs';
import {main} from '../scripts/refresh-fixtures.mjs';
const teams=[{id:1,name:'Home',short_name:'HOM',code:1},{id:2,name:'Away',short_name:'AWY',code:2}];
const raw=[{id:1,team_h:1,team_a:2,kickoff_time:'2026-10-14T12:00:00Z',started:false,finished:false,team_h_score:null,team_a_score:null}];
const options={now:()=>new Date('2026-10-13T10:00:00Z'),fetchJson:async url=>url.endsWith('fixtures/')?raw:{teams}};
test('access probe requires both valid feeds and makes no database calls',async()=>{
  assert.deepEqual(await checkFeedAccess(options),{ok:true,fixtures:1,teams:2});
  for(const path of ['fixtures/','bootstrap-static/']){
    await assert.rejects(checkFeedAccess({...options,fetchJson:async url=>{if(url.endsWith(path))throw Object.assign(new Error('blocked'),{status:403});return options.fetchJson(url);}}),/blocked/);
  }
});
test('refresh uses the shared transformation and persists only after validation',async()=>{
  let saved;
  const result=await refreshFixtures({refreshFixtures:async payload=>{saved=payload;return {resolved:0};}},options);
  assert.equal(result.updatedAt,'2026-10-13T10:00:00.000Z');assert.equal(saved.matches[0].id,1);
  assert.equal(saved.verifiedTeamCatalog,true);assert.equal(saved.raw,raw);
  let writes=0;
  await assert.rejects(refreshFixtures({refreshFixtures(){writes++;}}, {...options,fetchJson:async url=>url.endsWith('fixtures/')?[]:{teams}}),/Invalid fixture feed/);
  assert.equal(writes,0);
});
test('runtime retains team-catalog fallback, but the runner probe requires both feeds',async()=>{
  let saved;
  const fallback={...options,fetchJson:async url=>{if(url.endsWith('bootstrap-static/'))throw new Error('blocked');return raw;}};
  await refreshFixtures({getTeamCatalog:async()=>teams,refreshFixtures:async p=>{saved=p;return {};}},fallback);
  assert.equal(saved.verifiedTeamCatalog,false);
  await assert.rejects(checkFeedAccess(fallback),/blocked/);
});
test('invalid feed identities, dates and score types are rejected before storage',()=>{
  for(const input of [[],{},[...raw,...raw],[{...raw[0],id:0}],[{...raw[0],kickoff_time:'bad'}],[{...raw[0],team_a:1}],[{...raw[0],team_h_score:'4'}]])assert.throws(()=>validateFixtureFeed(input));
});
test('stale warnings appear only after 24 hours and recover on a successful refresh',()=>{
  const updated='2026-10-13T05:30:00Z',at=Date.parse(updated);
  assert.equal(fixtureFreshness(updated,at+86400000).stale,false);
  assert.equal(fixtureFreshness(updated,at+86400001).stale,true);
  assert.equal(fixtureFreshness('invalid',at).stale,true);
  assert.equal(fixtureFreshness(updated,at).message,'');
});
test('CLI refuses implicit or missing production configuration and closes connections',async()=>{
  let calls=0,closed=0;
  for(const env of [{},{PERSISTENCE_BACKEND:'blob',DATABASE_URL:'test',DATABASE_SCHEMA:'epl_oracle'},{PERSISTENCE_BACKEND:'neon',DATABASE_URL:'test',DATABASE_SCHEMA:'preview'}]){
    assert.equal(await main({env,storeFactory:()=>{calls++;},close:async()=>{closed++;}}),1);
  }
  assert.equal(calls,0);assert.equal(closed,3);
});
test('CLI returns a failure status for refresh errors and a success status only after persistence',async()=>{
  const env={PERSISTENCE_BACKEND:'neon',DATABASE_URL:'test',DATABASE_SCHEMA:'epl_oracle'};
  let closed=0;
  assert.equal(await main({env,storeFactory:()=>({}),refresh:async()=>{throw Object.assign(new Error('secret must not be printed'),{status:403});},close:async()=>{closed++;}}),1);
  assert.equal(await main({env,storeFactory:()=>({}),refresh:async()=>({ok:true,resolved:1}),close:async()=>{closed++;}}),0);
  assert.equal(closed,2);
});
