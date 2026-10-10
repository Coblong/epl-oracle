import {test, before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPostgresStore} from '../lib/postgres-store.mjs';
import {closeDatabase} from '../lib/store.mjs';
import fixturesHandler from '../api/fixtures.mjs';
import resultsHandler from '../api/results.mjs';
import predictionsHandler from '../api/cron/predictions.mjs';
import {predictFixtures} from '../lib/prediction-job.mjs';
import {generateWeeklyPredictions as runWeekly} from '../lib/weekly-predictions.mjs';
import {forecastPanel} from '../forecast-view.mjs';

const enabled=!!process.env.TEST_DATABASE_URL;
const schema='epl_oracle_test_'+randomUUID().replaceAll('-','');
let pool,store;
const teams=[{id:1,name:'Home',short_name:'HOM',code:1},{id:2,name:'Away',short_name:'AWY',code:2}];
const home={id:1,name:'Home',short:'HOM',code:1,recent:[],points:3},away={id:2,name:'Away',short:'AWY',code:2,recent:[],points:0};
const match={id:11,gameweek:2,kickoff:'2099-10-12T12:00:00Z',home,away};
const prediction={outcome:'home',score:[2,1],probabilities:{home:.6,draw:.25,away:.15},generatedAt:'2026-10-01T09:00:00Z',model:'typesafe-ai/jev'};
const result={id:10,gameweek:1,kickoff:'2026-09-25T12:00:00Z',home,away,prediction:{...prediction,generatedAt:'2026-09-20T09:00:00Z'},actualScore:[2,1],actualOutcome:'home',correctOutcome:true,correctScore:true,evaluatedAt:'2026-09-26T09:00:00Z'};
const baseline=()=>({fixtures:{matches:[structuredClone(match)],source:'Official Fantasy Premier League',updatedAt:'2026-10-01T08:00:00Z'},predictions:{11:{matchSignature:JSON.stringify(match),prediction:structuredClone(prediction)}},results:[structuredClone(result)]});

before(async()=>{
  if(!enabled) return;
  pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:6});
  store=createPostgresStore(pool,schema);
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
  process.env.DATABASE_SCHEMA=schema;
  process.env.PERSISTENCE_BACKEND='neon';
});
beforeEach(async()=>{
  if(!enabled) return;
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await store.initialize();
});
after(async()=>{
  if(!enabled) return;
  await closeDatabase();
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
});
const dbtest=(name,fn)=>test(name,{skip:!enabled},fn);
const generateWeeklyPredictions=(store,providers,now,wait)=>runWeekly(store,providers,now,wait,()=>new Date(now));
async function response(handler) {
  let body;
  const res={setHeader(){},end(text){body=JSON.parse(text);}};
  await handler({method:'GET'},res);
  assert.equal(res.statusCode,200);
  return body;
}
async function save(m=match,p=prediction,key='refresh') {
  const run=await store.beginRun(key);
  await store.saveSnapshot(run.id,m.id,m);
  await store.recordAttempt({runId:run.id,fixtureId:m.id,status:'started'});
  return {run,entry:{runId:run.id,fixtureId:m.id,matchSignature:JSON.stringify(m),prediction:p}};
}

dbtest('unvalidated Neon data cannot be served and a validated import preserves existing API views',async()=>{
  await assert.rejects(store.getFixtureView(),/not passed migration validation/);
  const report=await store.importSnapshot(baseline());
  assert.deepEqual([report.fixtures,report.upcoming,report.activePredictions,report.results],[2,1,1,1]);
  assert.equal(report.summary.outcomeAccuracy,1);
  assert.equal(report.summary.scoreAccuracy,1);
  const fixtures=await response(fixturesHandler),results=await response(resultsHandler);
  assert.equal(fixtures.matches[0].prediction.outcome,'home');
  assert.deepEqual(fixtures.matches[0].prediction.score,[2,1]);
  assert.equal(results.summary.resolved,1);
  assert.equal(results.results[0].correctScore,true);
});
dbtest('repeating an import is idempotent and changed snapshots cannot overwrite existing data',async()=>{
  const first=await store.importSnapshot(baseline());
  const second=await store.importSnapshot(baseline());
  assert.equal(first.digest,second.digest);
  assert.equal(second.repeated,true);
  const changed=baseline();changed.predictions[11].prediction.score=[3,1];
  await assert.rejects(store.importSnapshot(changed),/different snapshot/);
  assert.deepEqual((await store.getPredictions())[11].prediction.score,[2,1]);
});

dbtest('both providers use immutable shared evidence and retain independent successful revisions',async()=>{
  const source=baseline();source.predictions={};await store.importSnapshot(source);
  const seen=[];
  const providers={jev:async input=>{seen.push(structuredClone(input));input.home.name='Mutated';return prediction;},
    openai:async input=>{seen.push(structuredClone(input));return {...prediction,model:'gpt-6-luna',outcome:'away',score:[1,0]};}};
  assert.deepEqual(await predictFixtures(store,[match],providers,async()=>{}),{updated:2,failed:0});
  assert.deepEqual(seen,[match,match]);
  const row=(await pool.query(`SELECT id FROM "${schema}".runs WHERE run_key LIKE 'forecast:%'`)).rows[0];
  const run=await store.getRun(row.id);assert.deepEqual(run.snapshots[0].input,match);assert.equal(run.predictions.length,2);
  assert.ok(run.attempts.every(a=>a.status==='succeeded'));
  let live=(await response(fixturesHandler)).matches[0];
  assert.equal(live.predictions.jev.model,'typesafe-ai/jev');assert.equal(live.predictions.openai.model,'gpt-6-luna');
  assert.equal(live.predictions.openai.outcome,'away');assert.deepEqual(live.predictions.openai.score,[1,0]);
  const next={...match,kickoff:'2099-10-13T12:00:00Z'};
  await store.refreshFixtures({matches:[next],raw:[],teams,source:source.fixtures.source,updatedAt:'2026-10-02T08:00:00Z'});
  const newer={...prediction,score:[3,2],generatedAt:'2026-10-02T09:00:00Z'};
  assert.deepEqual(await predictFixtures(store,[next],{jev:async()=>newer,openai:async()=>{throw new Error('refused');}},async()=>{}),{updated:1,failed:1});
  live=(await response(fixturesHandler)).matches[0];
  assert.deepEqual(live.predictions.jev.score,[3,2]);assert.equal(live.predictions.jev.stale,false);
  assert.deepEqual(live.predictions.openai.score,[1,0]);assert.equal(live.predictions.openai.stale,true);
  assert.equal((await store.getRun(row.id)).predictions.length,2);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".predictions WHERE fixture_id=11`)).rows[0].count,3);
});

dbtest('Jev failure still saves OpenAI immediately and absent opinions stay absent',async()=>{
  const source=baseline();source.predictions={};await store.importSnapshot(source);
  const stats=await predictFixtures(store,[match],{jev:async()=>{throw new Error('network failure');},openai:async()=>({...prediction,model:'gpt-6-luna'})},async()=>{});
  assert.deepEqual(stats,{updated:1,failed:1});
  const live=(await response(fixturesHandler)).matches[0];
  assert.equal(live.predictions.jev,undefined);assert.equal(live.predictions.openai.model,'gpt-6-luna');
  let calls=0;
  await predictFixtures(store,[match],{openai:async()=>{calls++;return prediction;}},async()=>{});
  assert.equal(calls,0);
});

dbtest('a fixture returning to earlier evidence receives a visible new revision and then skips unchanged runs',async()=>{
  const source=baseline();source.predictions={};
  await store.importSnapshot(source);
  const states=[match,{...match,kickoff:'2099-10-14T12:00:00Z'},match];
  let calls=0;
  for (const [index,state] of states.entries()) {
    await store.refreshFixtures({matches:[state],raw:[],teams,source:source.fixtures.source,updatedAt:`2026-10-0${index+2}T08:00:00Z`});
    const stats=await predictFixtures(store,(await store.getFixtures()).matches,async()=>{
      calls++;
      return {...prediction,score:[calls,0],generatedAt:`2026-10-0${index+2}T09:00:00Z`};
    },async()=>{});
    assert.deepEqual(stats,{updated:1,failed:0});
    assert.deepEqual((await response(fixturesHandler)).matches[0].prediction.score,[index+1,0]);
  }
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".predictions WHERE fixture_id=11`)).rows[0].count,3);
  const repeated=await predictFixtures(store,(await store.getFixtures()).matches,async()=>{throw new Error('Unchanged evidence should not call provider');},async()=>{});
  assert.deepEqual(repeated,{updated:0,failed:0});
  assert.equal(calls,3);
});
dbtest('invalid source data or failed database inserts leave no partial import or readiness marker',async()=>{
  const invalid=baseline();invalid.results[0].correctScore=false;
  await assert.rejects(store.importSnapshot(invalid),/correctness flags/);
  assert.equal(await store.migrationReport(),undefined);
  // A source can pass application validation but violate a DB type constraint.
  const impossible=baseline();impossible.fixtures.matches.push({...match,id:2147483648});
  await assert.rejects(store.importSnapshot(impossible),/out of range/);
  assert.equal(await store.migrationReport(),undefined);
  const report=await store.importSnapshot(baseline());
  assert.equal(report.fixtures,2);
});
dbtest('runs retain immutable evidence, revisions and successful attempt status across retries',async()=>{
  await store.importSnapshot(baseline());
  const {run,entry}=await save();
  assert.deepEqual(await store.saveSnapshot(run.id,match.id,{different:'input'}),match);
  await Promise.all([store.savePrediction(entry),store.savePrediction({...entry,prediction:{...prediction,score:[3,1]}})]);
  await store.recordAttempt({runId:run.id,fixtureId:match.id,status:'failed',error:'late duplicate failure'});
  const saved=await store.getRun(run.id);
  assert.equal(saved.predictions.length,1);
  assert.equal(saved.attempts[0].status,'succeeded');
  const earlier=(await pool.query(`SELECT id FROM "${schema}".runs WHERE run_key='legacy-active:11'`)).rows[0];
  assert.deepEqual((await store.getRun(earlier.id)).predictions[0].data.score,[2,1]);
});
dbtest('overlapping prediction writes for different fixtures do not lose updates',async()=>{
  const source=baseline();const other={...match,id:12};source.fixtures.matches.push(other);
  await store.importSnapshot(source);
  const a=await save(match,{...prediction,generatedAt:'2026-10-02T09:00:00Z'},'a');
  const b=await save(other,{...prediction,outcome:'away',generatedAt:'2026-10-02T09:00:00Z'},'b');
  await Promise.all([store.savePrediction(a.entry),store.savePrediction(b.entry)]);
  const predictions=await store.getPredictions();
  assert.equal(predictions[11].prediction.outcome,'home');
  assert.equal(predictions[12].prediction.outcome,'away');
});
dbtest('overlapping weekly workers share one snapshot and claim each provider once',async()=>{
  const source=baseline();
  source.predictions={};
  source.fixtures.updatedAt='2099-10-07T08:00:00Z';
  source.fixtures.matches[0]={...match,kickoff:'2099-10-08T12:00:00Z'};
  await store.importSnapshot(source);
  let calls=0;
  const providers={jev:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,25));return prediction;},
    openai:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,25));return {...prediction,model:'gpt-6-luna'};}};
  const now='2099-10-07T08:00:00Z';
  const results=await Promise.all([
    generateWeeklyPredictions(store,providers,now),
    generateWeeklyPredictions(store,providers,now),
  ]);
  assert.equal(calls,2);
  assert.equal(results.reduce((sum,result)=>sum+result.updated,0),2);
  const run=(await pool.query(`SELECT id FROM "${schema}".runs WHERE run_key LIKE 'weekly:%'`)).rows[0];
  const saved=await store.getRun(run.id);
  assert.equal(saved.snapshots.length,1);
  assert.equal(saved.predictions.length,2);
  assert.equal(saved.attempts.length,2);
  assert.ok(saved.attempts.every(attempt=>attempt.status==='succeeded'));
});
dbtest('a failed weekly forecast retries from its frozen snapshot only before Thursday 09 London',async()=>{
  const source=baseline();
  source.predictions={};
  source.fixtures.updatedAt='2099-10-07T08:00:00Z';
  source.fixtures.matches[0]={...match,kickoff:'2099-10-08T12:00:00Z'};
  await store.importSnapshot(source);
  const seen=[];
  let calls=0;
  const providers={jev:async input=>{
    seen.push(structuredClone(input));
    if(calls++===0){input.home.name='Changed in the failed call';throw new Error('Transient provider error');}
    return prediction;
  }};
  const first=await generateWeeklyPredictions(store,providers,'2099-10-07T08:00:00Z',async()=>{});
  assert.deepEqual(first,{targeted:1,updated:0,failed:1});
  const retry=await generateWeeklyPredictions(store,providers,'2099-10-08T07:59:59Z',async()=>{});
  assert.deepEqual(retry,{targeted:1,updated:1,failed:0});
  assert.deepEqual(seen,[source.fixtures.matches[0],source.fixtures.matches[0]]);
  const run=(await pool.query(`SELECT id FROM "${schema}".runs WHERE run_key LIKE 'weekly:%'`)).rows[0];
  const saved=await store.getRun(run.id);
  assert.equal(saved.snapshots.length,1);
  assert.deepEqual(saved.snapshots[0].input,source.fixtures.matches[0]);
  assert.equal(saved.predictions.length,1);
  assert.equal(saved.attempts[0].status,'succeeded');
  const expired=await generateWeeklyPredictions(store,{jev:async()=>{throw new Error('The recovery window is closed');}},'2099-10-08T08:00:00Z');
  assert.deepEqual(expired,{targeted:0,updated:0,failed:0,skipped:'outside weekly run window'});
});
dbtest('provider claims serialize overlaps, retry failures once, and never reclaim success',async()=>{
  await store.importSnapshot(baseline());
  const run=await store.beginRun('weekly-claim-recovery','2099-10-07T08:00:00Z');
  await store.saveSnapshot(run.id,match.id,match);
  const claimUntil='2099-10-08T08:00:00Z';
  const entry={runId:run.id,fixtureId:match.id,provider:'jev',claimUntil,attemptAt:'2099-10-07T08:00:00Z'};
  const first=await Promise.all([store.claimAttempt(entry),store.claimAttempt(entry)]);
  assert.equal(first.filter(Boolean).length,1);
  assert.equal(await store.claimAttempt(entry),false);
  await store.recordAttempt({...entry,status:'failed',error:'Transient provider error'});
  assert.equal(await store.claimAttempt(entry),false);
  const retry={...entry,attemptAt:'2099-10-07T08:15:00Z'};
  const retried=await Promise.all([store.claimAttempt(retry),store.claimAttempt(retry)]);
  assert.equal(retried.filter(Boolean).length,1);
  await store.recordAttempt({...entry,status:'succeeded'});
  assert.equal(await store.claimAttempt(entry),false);

  const afterCutoff={...entry,provider:'openai',claimUntil:'2000-01-01T00:00:00Z'};
  await store.recordAttempt({...afterCutoff,status:'failed',error:'Missed retry window'});
  assert.equal(await store.claimAttempt(afterCutoff),false);

  const abandoned={...entry,provider:'gpt'};
  assert.equal(await store.claimAttempt(abandoned),true);
  assert.equal(await store.claimAttempt(abandoned),false);
  assert.equal(await store.claimAttempt({...abandoned,attemptAt:'2099-10-07T08:07:00Z'}),false);
  assert.equal(await store.claimAttempt({...abandoned,attemptAt:'2099-10-07T08:15:00Z'}),true);
});
dbtest('daily refresh resolves a final score once and does not revive it with a late prediction',async()=>{
  await store.importSnapshot(baseline());
  const late=await save();
  const refresh={matches:[],raw:[{id:11,event:2,team_h:1,team_a:2,kickoff_time:match.kickoff,finished:true,team_h_score:3,team_a_score:1}],teams,source:'Official Fantasy Premier League',updatedAt:'2026-10-03T08:00:00Z'};
  const changes=await Promise.all([store.refreshFixtures(refresh),store.refreshFixtures(refresh)]);
  assert.equal(changes.reduce((sum,r)=>sum+r.resolved,0),1);
  assert.equal(await store.savePrediction(late.entry),false);
  assert.deepEqual(await store.getPredictions(),{});
  const results=await response(resultsHandler);
  assert.equal(results.summary.resolved,2);
  assert.equal(results.summary.outcomeCorrect,2);
  assert.equal(results.summary.scoreCorrect,1);
  assert.deepEqual(results.results.find(r=>r.id===11).actualScore,[3,1]);
  assert.equal((await store.getRun(late.run.id)).predictions.length,0);
});
dbtest('a stale fixture refresh or prediction cannot overwrite newer evidence',async()=>{
  await store.importSnapshot(baseline());
  const late=await save();
  const changed={...match,home:{...home,points:6}};
  await store.refreshFixtures({matches:[changed],raw:[],teams,source:'Official Fantasy Premier League',updatedAt:'2026-10-04T08:00:00Z'});
  assert.equal(await store.savePrediction(late.entry),false);
  const stale=await store.refreshFixtures({matches:[match],raw:[],teams,source:'Official Fantasy Premier League',updatedAt:'2026-10-03T08:00:00Z'});
  assert.equal(stale.skipped,'older refresh');
  assert.equal((await store.getFixtures()).matches[0].home.points,6);
  assert.equal((await response(fixturesHandler)).matches[0].prediction,undefined);
});

dbtest('a failed fixture refresh rolls back result resolution and fixture changes together',async()=>{
  await store.importSnapshot(baseline());
  await assert.rejects(store.refreshFixtures({matches:[{...match,id:2147483648}],raw:[{id:11,event:2,team_h:1,team_a:2,kickoff_time:match.kickoff,finished:true,team_h_score:3,team_a_score:1}],teams,source:'Official Fantasy Premier League',updatedAt:'2026-10-03T08:00:00Z'}),/out of range/);
  assert.equal((await store.getResults()).length,1);
  assert.equal((await store.getFixtures()).matches[0].id,11);
  assert.equal((await store.getPredictions())[11].prediction.outcome,'home');
});

dbtest('failed provider attempts are retrievable without creating a prediction',async()=>{
  await store.importSnapshot(baseline());
  const {run}=await save();
  await store.recordAttempt({runId:run.id,fixtureId:match.id,status:'failed',error:'Provider unavailable'});
  const state=await store.getRun(run.id);
  assert.equal(state.attempts[0].status,'failed');
  assert.equal(state.attempts[0].error,'Provider unavailable');
  assert.equal(state.predictions.length,0);
  assert.deepEqual(state.snapshots[0].input,match);
});

dbtest('visitors see retained and missing forecasts after a failed provider refresh',async()=>{
  await store.importSnapshot(baseline());
  const refreshed={...match,home:{...home,points:6}};
  await store.refreshFixtures({matches:[refreshed],raw:[],teams,source:'Official Fantasy Premier League',updatedAt:'2026-10-02T08:00:00Z'});
  await predictFixtures(store,[refreshed],{jev:async()=>{throw new Error('Failure with a private credential');},openai:async()=>{throw new Error('Refused');}},async()=>{});
  const live=(await response(fixturesHandler)).matches[0];
  assert.equal(live.forecastStates.jev.availability,'retained');
  assert.equal(live.forecastStates.jev.status,'failed');
  assert.equal(live.forecastStates.openai.availability,'missing');
  assert.equal(live.forecastStates.openai.status,'failed');
  assert.equal(live.predictions.jev.generatedAt,prediction.generatedAt);
  assert.equal(live.predictions.openai,undefined);
  assert.match(forecastPanel(live,'jev',live.predictions.jev,live.forecastStates.jev),/Refresh failed.*Retaining the earlier forecast/);
  assert.match(forecastPanel(live,'openai',null,live.forecastStates.openai),/No prediction available.*Refresh failed/s);
  assert.ok(!JSON.stringify(live).includes('private credential'));
});

dbtest('the weekly cron records missing credentials as failures for both expected providers',async t=>{
  const source=baseline();source.predictions={};
  source.fixtures.updatedAt='2099-10-07T08:00:00Z';
  source.fixtures.matches[0]={...match,kickoff:'2099-10-08T12:00:00Z'};
  await store.importSnapshot(source);
  const saved=Object.fromEntries(['AI_GATEWAY_API_KEY','OPENAI_API_KEY','CRON_SECRET'].map(key=>[key,process.env[key]]));
  try {
    for(const key of Object.keys(saved))delete process.env[key];
    t.mock.timers.enable({apis:['Date'],now:Date.parse('2099-10-07T08:00:00Z')});
    const stats=await response(predictionsHandler);
    assert.equal(stats.failed,2);
    assert.equal(stats.updated,0);
    const live=(await response(fixturesHandler)).matches[0];
    for(const provider of ['jev','openai']){
      assert.equal(live.forecastStates[provider].status,'failed');
      assert.equal(live.forecastStates[provider].availability,'missing');
      assert.equal(live.predictions[provider],undefined);
    }
  } finally {
    t.mock.timers.reset();
    for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});

dbtest('weekly retries wait fifteen minutes, exhaust after three attempts and retain the older opinion',async()=>{
  const source=baseline();
  source.fixtures.updatedAt='2099-10-07T08:00:00Z';
  source.fixtures.matches[0]={...match,kickoff:'2099-10-08T12:00:00Z'};
  await store.importSnapshot(source);
  let calls=0;
  const providers={jev:async()=>{calls++;throw new Error('Rate limit including a private credential');}};
  assert.equal((await generateWeeklyPredictions(store,providers,'2099-10-07T08:00:00Z',async()=>{})).failed,1);
  assert.equal((await generateWeeklyPredictions(store,providers,'2099-10-07T08:14:59Z',async()=>{})).failed,0);
  assert.equal(calls,1);
  assert.equal((await generateWeeklyPredictions(store,providers,'2099-10-07T08:15:00Z',async()=>{})).failed,1);
  assert.equal((await generateWeeklyPredictions(store,providers,'2099-10-07T08:30:00Z',async()=>{})).failed,1);
  assert.equal((await generateWeeklyPredictions(store,providers,'2099-10-07T09:30:00Z',async()=>{})).failed,0);
  assert.equal(calls,3);
  const live=(await response(fixturesHandler)).matches[0];
  assert.equal(live.forecastStates.jev.status,'exhausted');
  assert.equal(live.forecastStates.jev.attemptCount,3);
  assert.equal(live.forecastStates.jev.availability,'retained');
  assert.equal(live.predictions.jev.generatedAt,prediction.generatedAt);
  assert.match(forecastPanel(live,'jev',live.predictions.jev,live.forecastStates.jev),/Retries exhausted.*Retaining the earlier forecast/);
  assert.ok(!JSON.stringify(live).includes('private credential'));
});

dbtest('the Thursday cutoff is visible without a write and the next cron persists expiry',async t=>{
  const source=baseline();source.predictions={};
  source.fixtures.updatedAt='2099-10-07T08:00:00Z';
  source.fixtures.matches[0]={...match,kickoff:'2099-10-08T12:00:00Z'};
  await store.importSnapshot(source);
  await generateWeeklyPredictions(store,{openai:async()=>{throw new Error('Timeout');}},'2099-10-07T08:00:00Z',async()=>{});
  const run=await store.beginRun('weekly:2099-10-07T08:00:00.000Z');
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2099-10-08T08:00:00Z')});
  const live=(await response(fixturesHandler)).matches[0];
  assert.equal(live.forecastStates.openai.status,'expired');
  assert.match(forecastPanel(live,'openai',null,live.forecastStates.openai),/Retry window expired/);
  assert.equal((await store.getRun(run.id)).attempts[0].status,'failed');
  let calls=0;
  const stats=await generateWeeklyPredictions(store,{openai:async()=>{calls++;}},'2099-10-08T08:00:00Z',async()=>{});
  assert.equal(stats.skipped,'outside weekly run window');
  assert.equal(calls,0);
  assert.equal((await store.getRun(run.id)).attempts[0].status,'expired');
});

dbtest('partial weekly success is visible immediately and only the failed provider retries to a fresh forecast',async()=>{
  const source=baseline();source.predictions={};
  source.fixtures.updatedAt='2099-10-07T08:00:00Z';
  source.fixtures.matches[0]={...match,kickoff:'2099-10-08T12:00:00Z'};
  await store.importSnapshot(source);
  let release,started;
  const waiting=new Promise(resolve=>{release=resolve;}),openaiStarted=new Promise(resolve=>{started=resolve;});
  const seen=[];
  const job=generateWeeklyPredictions(store,{jev:async()=>({...prediction,generatedAt:'2099-10-07T08:00:00Z'}),
    openai:async input=>{seen.push(structuredClone(input));started();await waiting;throw new Error('Temporary refusal');}},'2099-10-07T08:00:00Z',async()=>{});
  await openaiStarted;
  let live;
  try {
    for(let i=0;i<10;i++){live=(await response(fixturesHandler)).matches[0];if(live.predictions.jev)break;}
    assert.equal(live.forecastStates.jev.status,'succeeded');
    assert.equal(live.forecastStates.jev.availability,'fresh');
    assert.equal(live.forecastStates.openai.status,'started');
    assert.equal(live.predictions.openai,undefined);
  } finally {release();await job;}
  live=(await response(fixturesHandler)).matches[0];
  assert.equal(live.forecastStates.openai.status,'failed');
  assert.match(forecastPanel(live,'openai',null,live.forecastStates.openai),/Refresh failed/);
  let successfulProviderCalls=0;
  const retry=await generateWeeklyPredictions(store,{jev:async()=>{successfulProviderCalls++;return prediction;},
    openai:async input=>{seen.push(structuredClone(input));return {...prediction,model:'gpt-6-luna',generatedAt:'2099-10-07T08:15:00Z'};}},'2099-10-07T08:15:00Z',async()=>{});
  assert.equal(retry.updated,1);
  assert.equal(successfulProviderCalls,0);
  assert.deepEqual(seen,[source.fixtures.matches[0],source.fixtures.matches[0]]);
  live=(await response(fixturesHandler)).matches[0];
  assert.equal(live.forecastStates.openai.status,'succeeded');
  assert.equal(live.forecastStates.openai.availability,'fresh');
  assert.equal(live.forecastStates.openai.attemptCount,2);
  assert.match(forecastPanel(live,'openai',live.predictions.openai,live.forecastStates.openai),/2099-10-07T08:15:00Z/);
  assert.ok(!forecastPanel(live,'openai',live.predictions.openai,live.forecastStates.openai).includes('Refresh failed'));
});

dbtest('a recovered claim rejects the abandoned worker result and failure',async()=>{
  await store.importSnapshot(baseline());
  const run=await store.beginRun('weekly:2099-10-07T08:00:00.000Z','2099-10-07T08:00:00Z');
  await store.saveSnapshot(run.id,match.id,match);
  const first={runId:run.id,fixtureId:match.id,provider:'openai',claimUntil:'2099-10-08T08:00:00Z',attemptAt:'2099-10-07T08:00:00Z',claimToken:randomUUID(),matchSignature:JSON.stringify(match),prediction};
  assert.equal(await store.claimAttempt(first),true);
  const replacement={...first,attemptAt:'2099-10-07T08:15:00Z',claimToken:randomUUID(),prediction:{...prediction,score:[3,0]}};
  assert.equal(await store.claimAttempt(replacement),true);
  assert.equal(await store.savePrediction(first),false);
  await store.recordAttempt({...first,status:'failed',error:'Late abandoned failure'});
  assert.equal((await store.getRun(run.id)).attempts[0].status,'started');
  assert.equal(await store.savePrediction(replacement),true);
  const saved=await store.getRun(run.id);
  assert.equal(saved.attempts[0].status,'succeeded');
  assert.equal(saved.attempts[0].attemptCount,2);
  assert.equal(saved.predictions.length,1);
  assert.deepEqual(saved.predictions[0].data.score,[3,0]);
});

dbtest('an additive retry upgrade preserves old forecasts and does not reset new attempt budgets',async()=>{
  await store.importSnapshot(baseline());
  const legacy=await save(match,prediction,'weekly:2026-10-07T08:00:00.000Z');
  await store.recordAttempt({runId:legacy.run.id,fixtureId:match.id,provider:'jev',status:'failed'});
  // Recreate the old attempts table shape as an upgrade fixture.
  await pool.query(`ALTER TABLE "${schema}".attempts DROP COLUMN attempt_count,DROP COLUMN next_attempt_at,DROP COLUMN claim_token;
    ALTER TABLE "${schema}".attempts DROP CONSTRAINT attempts_status_check;
    ALTER TABLE "${schema}".attempts ADD CONSTRAINT attempts_status_check CHECK(status IN ('started','succeeded','failed'));
    DELETE FROM "${schema}".metadata WHERE key='retry_schema_v1'`);
  const report=await store.migrationReport();
  assert.equal((await store.upgradeRetries()).verified,true);
  assert.deepEqual(await store.migrationReport(),report);
  assert.deepEqual((await store.getPredictions())[11].prediction,prediction);
  assert.deepEqual((await store.getRun(legacy.run.id)).snapshots[0].input,match);
  assert.ok(['expired','exhausted'].includes((await store.getRun(legacy.run.id)).attempts[0].status));
  const run=await store.beginRun('weekly:2099-10-07T08:00:00.000Z','2099-10-07T08:00:00Z');
  await store.saveSnapshot(run.id,match.id,match);
  const entry={runId:run.id,fixtureId:match.id,provider:'openai',claimUntil:'2099-10-08T08:00:00Z',attemptAt:'2099-10-07T08:00:00Z',claimToken:randomUUID()};
  assert.equal(await store.claimAttempt(entry),true);
  await store.recordAttempt({...entry,status:'failed'});
  await store.upgradeRetries();
  assert.equal((await store.getRun(run.id)).attempts[0].status,'failed');
  assert.equal((await store.getRun(run.id)).attempts[0].attemptCount,1);
  assert.equal(await store.claimAttempt({...entry,attemptAt:'2099-10-07T08:14:59Z'}),false);
  assert.equal(await store.claimAttempt({...entry,attemptAt:'2099-10-07T08:15:00Z',claimToken:randomUUID()}),true);
  assert.equal((await store.getRun(run.id)).attempts[0].attemptCount,2);
});

dbtest('a provider never reached before the deadline has an expired missing state',async t=>{
  await store.importSnapshot(baseline());
  const run=await store.beginRun('weekly:2099-10-07T08:00:00.000Z','2099-10-07T08:00:00Z');
  await store.saveSnapshot(run.id,match.id,match);
  await store.settleAttempts('2099-10-08T08:00:00Z');
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2099-10-08T08:00:00Z')});
  const live=(await response(fixturesHandler)).matches[0];
  assert.equal(live.forecastStates.openai.status,'expired');
  assert.equal(live.forecastStates.openai.availability,'missing');
  assert.equal(live.forecastStates.openai.attemptCount,0);
  assert.equal((await store.getRun(run.id)).predictions.length,0);
});

dbtest('a slow failed evaluation still leaves a full fifteen-minute interval before retry',async()=>{
  const source=baseline();source.predictions={};
  source.fixtures.updatedAt='2099-10-07T08:00:00Z';
  source.fixtures.matches[0]={...match,kickoff:'2099-10-08T12:00:00Z'};
  await store.importSnapshot(source);
  let calls=0,clockCalls=0;
  const provider=async()=>{calls++;throw new Error('Timeout');};
  await runWeekly(store,{openai:provider},'2099-10-07T08:00:00Z',async()=>{},()=>new Date(clockCalls++===0?'2099-10-07T08:00:00Z':'2099-10-07T08:02:00Z'));
  await generateWeeklyPredictions(store,{openai:provider},'2099-10-07T08:15:00Z',async()=>{});
  assert.equal(calls,1);
  await generateWeeklyPredictions(store,{openai:provider},'2099-10-07T08:17:00Z',async()=>{});
  assert.equal(calls,2);
});
