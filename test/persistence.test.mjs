import {test, before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPostgresStore} from '../lib/postgres-store.mjs';
import {closeDatabase} from '../lib/store.mjs';
import fixturesHandler from '../api/fixtures.mjs';
import resultsHandler from '../api/results.mjs';
import {predictFixtures} from '../lib/prediction-job.mjs';

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
