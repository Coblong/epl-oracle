import {runSchemaMigrations} from '../lib/schema-migrations.mjs';
import {test, before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPostgresStore} from '../lib/postgres-store.mjs';
import {closeDatabase} from '../lib/store.mjs';
import fixturesHandler from '../api/fixtures.mjs';
import resultsHandler from '../api/results.mjs';
import fixturesCronHandler from '../api/cron/fixtures.mjs';
import predictionsHandler from '../api/cron/predictions.mjs';
import activateHandler from '../api/competition/activate.mjs';
import manualPredictionHandler from '../api/cron/predictions/manual.mjs';
import {predictFixtures} from '../lib/prediction-job.mjs';
import {generateCompetitionPredictions as runCompetition,generateWeeklyPredictions as runWeekly} from '../lib/weekly-predictions.mjs';
import {parsePrediction} from '../lib/football.mjs';
import {scoreAnswer} from './support/score-distribution.mjs';
import {forecastPanel} from '../forecast-view.mjs';
import {renderResultCard} from '../result-card.mjs';
import {renderGameweekView} from '../gameweek-view.mjs';
import {renderCompetitionStandings} from '../leaderboard.mjs';

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
async function response(handler,request={method:'GET'}) {
  let body;
  const res={setHeader(){},end(text){body=JSON.parse(text);}};
  await handler(request,res);
  assert.equal(res.statusCode,200);
  return body;
}
async function save(m=match,p=prediction,key='refresh') {
  const run=await store.beginRun(key);
  await store.saveSnapshot(run.id,m.id,m);
  await store.recordAttempt({runId:run.id,fixtureId:m.id,status:'started'});
  return {run,entry:{runId:run.id,fixtureId:m.id,matchSignature:JSON.stringify(m),prediction:p}};
}

dbtest('unvalidated Neon data cannot be served and the new Results API does not copy legacy history',async()=>{
  await assert.rejects(store.getFixtureView(),/not passed migration validation/);
  const report=await store.importSnapshot(baseline());
  assert.deepEqual([report.fixtures,report.upcoming,report.activePredictions,report.results],[2,1,1,1]);
  assert.equal(report.summary.outcomeAccuracy,1);
  assert.equal(report.summary.scoreAccuracy,1);
  const fixtures=await response(fixturesHandler),results=await response(resultsHandler);
  assert.equal(fixtures.matches[0].prediction.outcome,'home');
  assert.deepEqual(fixtures.matches[0].prediction.score,[2,1]);
  assert.equal(results.summary.resolved,1);
  assert.deepEqual(results.results,[]);
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
  const completedFixture={...match,kickoff:'2026-10-02T07:00:00Z'};
  const late=await save(completedFixture,{...prediction,generatedAt:'2026-10-02T08:00:00Z'});
  const refresh={matches:[],raw:[{id:11,event:2,team_h:1,team_a:2,kickoff_time:completedFixture.kickoff,finished:true,team_h_score:3,team_a_score:1}],teams,source:'Official Fantasy Premier League',updatedAt:'2026-10-03T08:00:00Z'};
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

dbtest('Results use each provider latest pre-reschedule forecast and official score corrections update correctness',async()=>{
  const postponed={...match,kickoff:'2099-10-10T12:00:00Z'};
  const second={...match,id:12,kickoff:'2099-10-12T15:00:00Z'};
  const source=baseline();source.predictions={};source.results=[];source.fixtures.matches=[postponed,second];
  await store.importSnapshot(source);
  async function saveForecast(fixture,provider,prediction,key){
    const run=await store.beginRun(key,prediction.generatedAt);
    await store.saveSnapshot(run.id,fixture.id,fixture);
    await store.recordAttempt({runId:run.id,fixtureId:fixture.id,provider,status:'started',attemptAt:prediction.generatedAt});
    assert.equal(await store.savePrediction({runId:run.id,fixtureId:fixture.id,provider,matchSignature:JSON.stringify(fixture),prediction,completedAt:prediction.generatedAt}),true);
  }
  const jevOld={...prediction,outcome:'away',score:[0,0],generatedAt:'2099-10-09T09:00:00Z'};
  await saveForecast(postponed,'jev',jevOld,'old-before-postponement');
  const revised={...postponed,kickoff:'2099-10-12T12:00:00Z'};
  await store.refreshFixtures({matches:[revised,second],raw:[
    {id:11,event:2,team_h:1,team_a:2,kickoff_time:revised.kickoff,finished:false,started:false},
    {id:12,event:2,team_h:1,team_a:2,kickoff_time:second.kickoff,finished:false,started:false},
  ],teams,source:source.fixtures.source,updatedAt:'2099-10-10T08:00:00Z'});
  assert.deepEqual((await store.getFixtures()).matches.find(f=>f.id===11),revised);
  const jevLatest={...prediction,score:[3,1],generatedAt:'2099-10-11T09:00:00Z'};
  const openaiLatest={...prediction,outcome:'away',score:[2,1],model:'gpt-6-luna',generatedAt:'2099-10-11T10:00:00Z'};
  await saveForecast(revised,'jev',jevLatest,'jev-after-reschedule');
  await saveForecast(revised,'openai',openaiLatest,'openai-after-reschedule');
  await saveForecast(second,'jev',{...prediction,generatedAt:'2099-10-11T11:00:00Z'},'second-jev');

  const raw=[
    {id:11,event:2,team_h:1,team_a:2,kickoff_time:revised.kickoff,finished:true,team_h_score:2,team_a_score:1},
    {id:12,event:2,team_h:1,team_a:2,kickoff_time:second.kickoff,finished:true,team_h_score:1,team_a_score:0},
  ];
  await store.refreshFixtures({matches:[],raw,teams,source:source.fixtures.source,updatedAt:'2099-10-13T08:00:00Z'});
  let page=await store.getResultsPage({page:1,pageSize:20});
  const first=page.results.find(result=>result.id===11);
  assert.deepEqual(first.actualScore,[2,1]);
  assert.deepEqual(first.forecasts.jev.prediction.score,[3,1]);
  assert.equal(first.forecasts.jev.correctOutcome,true);
  assert.equal(first.forecasts.jev.correctScore,false);
  assert.equal(first.forecasts.openai.prediction.outcome,'away');
  assert.equal(first.forecasts.openai.correctOutcome,false);
  assert.equal(first.forecasts.openai.correctScore,true);
  assert.deepEqual(page.results.find(result=>result.id===12).missingProviders,['openai','claude','chatgpt','gemini']);
  assert.equal(page.providerSummaries.jev.resolved,2);
  assert.equal(page.providerSummaries.jev.outcomeCorrect,2);
  assert.equal(page.providerSummaries.jev.brierSampleCount,2);
  assert.equal(page.providerSummaries.openai.resolved,1);
  assert.equal(page.sharedComparison.resolved,0);
  assert.equal(page.sharedComparison.providerSummaries.jev.resolved,0);
  assert.equal(page.sharedComparison.providerSummaries.openai.resolved,0);
  const smallerPage=await store.getResultsPage({page:1,pageSize:1});
  assert.equal(smallerPage.results.length,1);
  assert.deepEqual(smallerPage.providerSummaries,page.providerSummaries);
  assert.deepEqual(smallerPage.sharedComparison,page.sharedComparison);

  const corrected=raw.map(f=>f.id===11?{...f,team_h_score:0,team_a_score:1}:f);
  await store.refreshFixtures({matches:[],raw:corrected,teams,source:source.fixtures.source,updatedAt:'2099-10-14T08:00:00Z'});
  page=await store.getResultsPage({page:1,pageSize:20});
  const updated=page.results.find(result=>result.id===11);
  assert.deepEqual(updated.actualScore,[0,1]);
  assert.equal(updated.forecasts.jev.correctOutcome,false);
  assert.equal(updated.forecasts.openai.correctOutcome,true);
  assert.equal(updated.forecasts.openai.correctScore,false);
  assert.equal(page.summary.resolved,2);
  assert.equal(page.providerSummaries.jev.outcomeCorrect,1);
  assert.equal(page.providerSummaries.openai.outcomeCorrect,1);
  assert.equal(page.sharedComparison.providerSummaries.jev.outcomeCorrect,0);
  assert.equal(page.sharedComparison.providerSummaries.openai.outcomeCorrect,0);
  assert.equal(page.sharedComparison.providerSummaries.jev.brierScore,null);
  const api=await response(resultsHandler,{method:'GET',url:'/api/results?page=1'});
  assert.equal(api.results.find(result=>result.id===11).forecasts.openai.correctOutcome,true);
  assert.deepEqual(api.results.find(result=>result.id===12).missingProviders,['openai','claude','chatgpt','gemini']);
});

dbtest('Results expose earned and mean-assigned O Scores without adding missing forecasts',async()=>{
  const withoutForecast={...match,id:12,kickoff:'2099-10-12T15:00:00Z'};
  const source=baseline();source.predictions={};source.results=[];source.fixtures.matches=[match,withoutForecast];
  await store.importSnapshot(source);
  async function saveScoreForecast(provider,score,outcome,generatedAt){
    const forecast={...prediction,score,outcome,generatedAt};
    const run=await store.beginRun(`o-score-${provider}`,generatedAt);
    await store.saveSnapshot(run.id,match.id,match);
    await store.recordAttempt({runId:run.id,fixtureId:match.id,provider,status:'started',attemptAt:generatedAt});
    assert.equal(await store.savePrediction({runId:run.id,fixtureId:match.id,provider,matchSignature:JSON.stringify(match),prediction:forecast,completedAt:generatedAt}),true);
  }
  await saveScoreForecast('jev',[5,0],'home','2099-10-11T08:00:00Z');
  await saveScoreForecast('openai',[4,0],'home','2099-10-11T09:00:00Z');
  await store.refreshFixtures({matches:[],teams,source:source.fixtures.source,updatedAt:'2099-10-13T08:00:00Z',raw:[
    {id:match.id,event:2,kickoff_time:match.kickoff,team_h:1,team_a:2,team_h_score:5,team_a_score:0,finished:true},
    {id:withoutForecast.id,event:2,kickoff_time:withoutForecast.kickoff,team_h:1,team_a:2,team_h_score:0,team_a_score:0,finished:true},
  ]});

  const page=await store.getResultsPage();
  const result=page.results.find(row=>row.id===match.id);
  assert.equal(result.oScores.jev.value,0);
  assert.equal(result.oScores.jev.source,'earned');
  assert.deepEqual([result.oScores.openai.homeGoalError,result.oScores.openai.awayGoalError,result.oScores.openai.resultPenalty],[1,0,0]);
  assert.equal(result.oScores.openai.value,1);
  assert.equal(result.oScores.claude.value,0.5);
  assert.equal(result.oScores.claude.source,'mean_assigned');
  assert.equal(result.oScores.claude.homeGoalError,null);
  assert.equal(result.forecasts.claude,undefined);
  assert.deepEqual(result.missingProviders,['claude','chatgpt','gemini']);
  assert.deepEqual(page.providerSummaries.claude.oScoreDiagnostics,
    {scope:'full_history',eligibleMatchCount:2,submittedCount:0,missingCount:2,earnedCount:0,meanAssignedCount:1,unavailableCount:1,sampleCount:1,total:0.5,average:0.5});
  const allMissing=page.results.find(row=>row.id===withoutForecast.id);
  assert.deepEqual(allMissing.actualScore,[0,0]);
  assert.deepEqual(allMissing.missingProviders,['jev','openai','claude','chatgpt','gemini']);
  assert.deepEqual(allMissing.forecasts,{});
  for(const score of Object.values(allMissing.oScores)) assert.equal(score.source,'unavailable');

  const api=await response(resultsHandler,{method:'GET',url:'/api/results'});
  assert.deepEqual(api.competition,{active:false,startedAt:null,includedFixtureBoundary:null});
  assert.equal(api.scoringRules.id,'oracle-score-v1');
  assert.equal(api.results.find(row=>row.id===match.id).oScores.claude.source,'mean_assigned');
  assert.equal(api.sharedComparison.oScoreDiagnostics.scope,'shared_all_agents');
  assert.equal(api.sharedComparison.oScoreDiagnostics.resolved,0);
  assert.equal(api.sharedComparison.oScoreDiagnostics.providerSummaries.jev.sampleCount,0);

  await store.refreshFixtures({matches:[],teams,source:source.fixtures.source,updatedAt:'2099-10-14T08:00:00Z',raw:[
    {id:match.id,event:2,kickoff_time:match.kickoff,team_h:1,team_a:2,team_h_score:4,team_a_score:1,finished:true},
    {id:withoutForecast.id,event:2,kickoff_time:withoutForecast.kickoff,team_h:1,team_a:2,team_h_score:0,team_a_score:0,finished:true},
  ]});
  const corrected=await store.getResultsPage();
  const correctedResult=corrected.results.find(row=>row.id===match.id);
  assert.equal(correctedResult.oScores.jev.value,2);
  assert.equal(correctedResult.oScores.openai.value,1);
  assert.equal(correctedResult.oScores.claude.value,1.5);
  assert.deepEqual(corrected.providerSummaries.jev.oScoreDiagnostics,
    {scope:'full_history',eligibleMatchCount:2,submittedCount:1,missingCount:1,earnedCount:1,meanAssignedCount:0,unavailableCount:1,sampleCount:1,total:2,average:2});
  assert.deepEqual(corrected.providerSummaries.claude.oScoreDiagnostics,
    {scope:'full_history',eligibleMatchCount:2,submittedCount:0,missingCount:2,earnedCount:0,meanAssignedCount:1,unavailableCount:1,sampleCount:1,total:1.5,average:1.5});
});

dbtest('daily refresh settles provisional final scores, retains both pre-kickoff forecasts, and leaves an unconfirmed 90-minute match unresolved',async()=>{
  const kickoff='2026-10-10T11:00:00Z';
  const provisional={...match,id:71,kickoff};
  const elapsed={...match,id:72,kickoff:'2026-10-10T12:00:00Z'};
  const source=baseline();source.predictions={};source.results=[];source.fixtures.matches=[provisional,elapsed];
  await store.importSnapshot(source);
  for(const [fixture,provider,forecast] of [
    [provisional,'jev',{...prediction,outcome:'away',score:[1,2],generatedAt:'2026-10-10T10:00:00Z'}],
    [provisional,'openai',{...prediction,generatedAt:'2026-10-10T10:05:00Z',model:'gpt-6-luna'}],
  ]){
    const run=await store.beginRun(`provisional-${fixture.id}-${provider}`,forecast.generatedAt);
    await store.saveSnapshot(run.id,fixture.id,fixture);
    await store.recordAttempt({runId:run.id,fixtureId:fixture.id,provider,status:'started',attemptAt:forecast.generatedAt});
    assert.equal(await store.savePrediction({runId:run.id,fixtureId:fixture.id,provider,matchSignature:JSON.stringify(fixture),prediction:forecast,completedAt:forecast.generatedAt}),true);
  }
  const raw=[
    {id:71,event:2,team_h:1,team_a:2,kickoff_time:kickoff,finished:false,finished_provisional:true,started:true,minutes:90,team_h_score:2,team_a_score:1},
    {id:72,event:2,team_h:1,team_a:2,kickoff_time:elapsed.kickoff,finished:false,finished_provisional:false,started:true,minutes:90,team_h_score:4,team_a_score:0},
  ];
  await store.refreshFixtures({matches:[],raw,teams,source:source.fixtures.source,updatedAt:'2026-10-10T20:00:00Z'});
  let page=await store.getResultsPage();
  let result=page.results.find(item=>item.id===71);
  assert.deepEqual(result.actualScore,[2,1]);
  assert.equal(result.forecasts.jev.correctOutcome,false);
  assert.equal(result.forecasts.openai.correctOutcome,true);
  assert.equal(page.results.some(item=>item.id===72),false);

  await store.refreshFixtures({matches:[],raw:[{...raw[0],finished:true,finished_provisional:false,team_h_score:1,team_a_score:1},raw[1]],teams,source:source.fixtures.source,updatedAt:'2026-10-10T21:00:00Z'});
  page=await store.getResultsPage();
  result=page.results.find(item=>item.id===71);
  assert.deepEqual(result.actualScore,[1,1]);
  assert.equal(result.forecasts.jev.correctOutcome,false);
  assert.equal(result.forecasts.openai.correctOutcome,false);
  assert.equal(result.forecasts.jev.correctScore,false);
  assert.equal(result.forecasts.openai.correctScore,false);
  assert.equal(page.results.some(item=>item.id===72),false);
});

dbtest('fixture cron uses persisted team references when bootstrap-static is forbidden and fails closed on unknown teams',async t=>{
  const kickoff='2026-10-10T11:00:00Z';
  const fixture={...match,id:81,kickoff};
  const source=baseline();source.predictions={};source.results=[];source.fixtures.matches=[fixture];
  await store.importSnapshot(source);
  for(const provider of ['jev','openai']){
    const generatedAt=`2026-10-10T10:0${provider==='jev'?'0':'5'}:00Z`;
    const run=await store.beginRun(`feed-recovery-${provider}`,generatedAt);
    await store.saveSnapshot(run.id,fixture.id,fixture);
    await store.recordAttempt({runId:run.id,fixtureId:fixture.id,provider,status:'started',attemptAt:generatedAt});
    assert.equal(await store.savePrediction({runId:run.id,fixtureId:fixture.id,provider,matchSignature:JSON.stringify(fixture),prediction:{...prediction,generatedAt,model:provider},completedAt:generatedAt}),true);
  }
  const raw=[{id:81,event:2,team_h:1,team_a:2,kickoff_time:kickoff,finished:false,finished_provisional:true,started:true,team_h_score:2,team_a_score:1}];
  const originalFetch=global.fetch;
  const invoke=async({bootstrapStatus=403,fixtureStatus=200,fixtures=raw,bootstrapTeams=teams,bootstrapDelay=0}={})=>{
    global.fetch=async url=>String(url).endsWith('/fixtures/')
      ? new Response(JSON.stringify(fixtures),{status:fixtureStatus,headers:{'content-type':'application/json'}})
      : (await new Promise(resolve=>setTimeout(resolve,bootstrapDelay)),new Response(JSON.stringify({teams:bootstrapTeams}),{status:bootstrapStatus,headers:{'content-type':'application/json'}}));
    let body;
    const res={setHeader(){},end(text){body=JSON.parse(text);}};
    await fixturesCronHandler({headers:{}},res);
    return {status:res.statusCode,body};
  };
  t.after(()=>{global.fetch=originalFetch;});

  const recovered=await invoke();
  assert.equal(recovered.status,200);
  assert.equal(recovered.body.resolved,1);
  let page=await store.getResultsPage();
  assert.deepEqual(page.results.find(item=>item.id===81).actualScore,[2,1]);
  assert.equal(page.results.find(item=>item.id===81).forecasts.jev.correctScore,true);
  assert.equal(page.results.find(item=>item.id===81).forecasts.openai.correctScore,true);
  assert.equal((await pool.query(`SELECT 1 FROM "${schema}".metadata WHERE key='team_catalog'`)).rowCount,0);

  const verified=await invoke({bootstrapStatus:200,bootstrapDelay:40});
  assert.equal(verified.status,200);
  const catalog=(await pool.query(`SELECT value FROM "${schema}".metadata WHERE key='team_catalog'`)).rows[0].value;
  assert.deepEqual(catalog.teams.map(team=>team.id).sort((a,b)=>a-b),[1,2]);
  const fixtureMetadata=(await pool.query(`SELECT value FROM "${schema}".metadata WHERE key='fixtures'`)).rows[0].value;
  assert.ok(Date.parse(fixtureMetadata.updatedAt)<Date.parse(catalog.updatedAt));

  await pool.query(`CREATE FUNCTION "${schema}".reject_fixture_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.key='fixtures' THEN RAISE EXCEPTION 'forced test rollback'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_fixture_metadata BEFORE INSERT OR UPDATE ON "${schema}".metadata
      FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_fixture_metadata()`);
  const failedRefresh=await invoke({bootstrapStatus:200,bootstrapTeams:teams.map(team=>({...team,short_name:'NEW'}))});
  assert.equal(failedRefresh.status,502);
  await pool.query(`DROP TRIGGER reject_fixture_metadata ON "${schema}".metadata; DROP FUNCTION "${schema}".reject_fixture_metadata()`);
  const afterRollback=(await pool.query(`SELECT value FROM "${schema}".metadata WHERE key='team_catalog'`)).rows[0].value;
  assert.deepEqual(afterRollback,catalog);

  const reused=await invoke();
  assert.equal(reused.status,200);
  const afterFallback=(await pool.query(`SELECT value FROM "${schema}".metadata WHERE key='team_catalog'`)).rows[0].value;
  assert.deepEqual(afterFallback,catalog);

  const unknown=await invoke({fixtures:[{...raw[0],id:82,team_h:999}]});
  assert.equal(unknown.status,502);
  page=await store.getResultsPage();
  assert.equal(page.results.some(item=>item.id===82),false);
  const unavailable=await invoke({fixtureStatus:403});
  assert.equal(unavailable.status,502);
  page=await store.getResultsPage();
  assert.equal(page.results.length,1);
});

dbtest('the Results API paginates the current season in groups of twenty',async()=>{
  const source=baseline();source.predictions={};source.results=[];
  source.fixtures.matches=Array.from({length:21},(_,index)=>({...match,id:100+index,kickoff:`2099-10-${String(index+1).padStart(2,'0')}T12:00:00Z`}));
  await store.importSnapshot(source);
  const raw=source.fixtures.matches.map(f=>({id:f.id,event:f.gameweek,team_h:1,team_a:2,kickoff_time:f.kickoff,finished:true,team_h_score:1,team_a_score:0}));
  await store.refreshFixtures({matches:[],raw,teams,source:source.fixtures.source,updatedAt:'2099-11-01T08:00:00Z'});
  const first=await response(resultsHandler,{method:'GET',url:'/api/results?page=1'});
  const secondPage=await response(resultsHandler,{method:'GET',url:'/api/results?page=2'});
  assert.equal(first.results.length,20);
  assert.equal(first.pageSize,20);
  assert.equal(first.total,21);
  assert.equal(first.hasMore,true);
  assert.equal(secondPage.results.length,1);
  assert.equal(secondPage.hasMore,false);
});

dbtest('gameweek summaries use the full official season, preserve postponed rounds and recalculate corrections',async()=>{
  const kickoff=(day,hour='12')=>`2026-09-${String(day).padStart(2,'0')}T${hour}:00:00Z`;
  const fixtures=[
    {id:201,gameweek:1,kickoff:kickoff(1),home,away},
    {id:202,gameweek:1,kickoff:kickoff(2),home,away},
    {id:203,gameweek:1,kickoff:kickoff(3),home,away},
    ...Array.from({length:21},(_,index)=>({id:204+index,gameweek:2,kickoff:kickoff(index+1,'15'),home,away})),
  ];
  const source=baseline();source.predictions={};source.results=[{...result,id:199,kickoff:'2025-09-01T12:00:00Z'}];
  source.fixtures={...source.fixtures,matches:fixtures,updatedAt:'2026-10-01T08:00:00Z'};
  await store.importSnapshot(source);
  const scored=fixtures[0];
  for(const [provider,score,at] of [
    ['jev',[5,0],'2026-08-31T08:00:00Z'],['openai',[4,0],'2026-08-31T09:00:00Z'],
  ]){
    const forecast={...prediction,score,generatedAt:at};
    const run=await store.beginRun(`gameweek-${provider}`,at);
    await store.saveSnapshot(run.id,scored.id,scored);
    await store.recordAttempt({runId:run.id,fixtureId:scored.id,provider,status:'started',attemptAt:at});
    assert.equal(await store.savePrediction({runId:run.id,fixtureId:scored.id,provider,
      matchSignature:JSON.stringify(scored),prediction:forecast,completedAt:at}),true);
  }
  const raw=fixtures.map(f=>({id:f.id,event:f.gameweek,team_h:1,team_a:2,kickoff_time:f.kickoff,finished:true,team_h_score:2,team_a_score:1}));
  raw[1]={...raw[1],cancelled:true,finished:false,team_h_score:null,team_a_score:null};
  raw[2]={id:203,event:null,team_h:1,team_a:2,kickoff_time:null,finished:false,started:false};
  await store.refreshFixtures({matches:[{...fixtures[2],gameweek:null,kickoff:null,fixtureStatus:'awaiting_date'}],raw,teams,
    source:source.fixtures.source,updatedAt:'2026-10-01T08:00:00Z'});

  const first=await response(resultsHandler,{method:'GET',url:'/api/results?page=1'});
  const second=await response(resultsHandler,{method:'GET',url:'/api/results?page=2'});
  assert.equal(first.results.length,20);
  assert.equal(second.results.length,3);
  assert.deepEqual(first.gameweeks,second.gameweeks);
  const [weekOne,weekTwo]=first.gameweeks;
  assert.deepEqual(weekOne.counts,{fixtures:2,completed:1,remaining:1,cancelled:1});
  assert.equal(weekOne.complete,false);
  assert.equal(weekOne.oScoreSummaries.jev.total,4);
  assert.equal(weekOne.oScoreSummaries.openai.total,3);
  assert.equal(weekOne.oScoreSummaries.claude.total,3.5);
  assert.equal(weekOne.providerSummaries.claude.resolved,0);
  assert.deepEqual(weekTwo.counts,{fixtures:21,completed:21,remaining:0,cancelled:0});
  assert.equal(weekTwo.complete,true);

  await store.refreshFixtures({matches:[],raw:raw.filter(fixture=>fixture.id!==203),teams,
    source:source.fixtures.source,updatedAt:'2026-10-01T09:00:00Z'});
  const temporarilyMissing=(await response(resultsHandler)).gameweeks[0];
  assert.deepEqual(temporarilyMissing.counts,{fixtures:2,completed:1,remaining:1,cancelled:1});
  assert.equal(temporarilyMissing.complete,false);

  raw[0]={...raw[0],team_h_score:4,team_a_score:1};
  await store.refreshFixtures({matches:[{...fixtures[2],gameweek:null,kickoff:null,fixtureStatus:'awaiting_date'}],raw,teams,
    source:source.fixtures.source,updatedAt:'2026-10-02T08:00:00Z'});
  const corrected=(await response(resultsHandler)).gameweeks[0];
  assert.equal(corrected.oScoreSummaries.jev.total,2);
  assert.equal(corrected.oScoreSummaries.openai.total,1);
  assert.equal(corrected.oScoreSummaries.claude.total,1.5);

  raw[2]={...raw[2],event:2,kickoff_time:'2026-10-30T12:00:00Z'};
  await store.refreshFixtures({matches:[{...fixtures[2],gameweek:2,kickoff:raw[2].kickoff_time}],raw,teams,
    source:source.fixtures.source,updatedAt:'2026-10-03T08:00:00Z'});
  const reassigned=(await response(resultsHandler)).gameweeks;
  assert.deepEqual(reassigned.map(week=>[week.gameweek,week.counts.fixtures,week.counts.remaining]),[[1,1,0],[2,22,1]]);
  assert.equal(reassigned[0].counts.cancelled,1);

  await store.refreshFixtures({matches:[],raw:[{id:300,event:1,team_h:1,team_a:2,kickoff_time:'2027-08-10T12:00:00Z',
    finished:true,team_h_score:1,team_a_score:0}],teams,source:source.fixtures.source,updatedAt:'2027-09-01T08:00:00Z'});
  const nextSeason=(await response(resultsHandler)).gameweeks;
  assert.deepEqual(nextSeason.map(week=>[week.gameweek,week.counts.fixtures]),[[1,1]]);
});

dbtest('lost or missing fixture data stays awaiting update and only an explicit cancellation removes it from totals',async()=>{
  const source=baseline();await store.importSnapshot(source);
  const lost={id:11,event:2,team_h:1,team_a:2,kickoff_time:null,finished:false,started:false,provisional_start_time:true};
  await store.refreshFixtures({matches:[{...match,kickoff:null,fixtureStatus:'awaiting_date'}],raw:[lost],teams,source:source.fixtures.source,updatedAt:'2026-10-02T08:00:00Z'});
  let fixture=(await store.getFixtures()).matches[0];
  assert.equal(fixture.kickoff,null);
  assert.equal(fixture.fixtureStatus,'awaiting_rescheduling');
  await store.refreshFixtures({matches:[],raw:[{id:99,event:2,team_h:1,team_a:2,kickoff_time:'2099-10-13T12:00:00Z',finished:false,started:false}],teams,source:source.fixtures.source,updatedAt:'2026-10-03T08:00:00Z'});
  fixture=(await store.getFixtures()).matches[0];
  assert.equal(fixture.fixtureStatus,'awaiting_update');
  const cancelled={...lost,cancelled:true};
  await store.refreshFixtures({matches:[],raw:[cancelled],teams,source:source.fixtures.source,updatedAt:'2026-10-04T08:00:00Z'});
  assert.deepEqual((await store.getFixtures()).matches,[]);
  const page=await store.getResultsPage();
  assert.equal(page.results.find(result=>result.id===11).status,'cancelled');
  assert.equal(page.providerSummaries.jev.resolved,0);
  assert.equal(page.providerSummaries.openai.resolved,0);
  assert.equal(page.sharedComparison.resolved,0);
  assert.equal(page.providerSummaries.jev.brierScore,null);
  assert.equal(page.summary.resolved,1);
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

dbtest('an overdue forecast is retained when stale fixture data prevents a new weekly snapshot',async t=>{
  const source=baseline();source.predictions={};source.fixtures.updatedAt='2099-10-05T08:00:00Z';
  await store.importSnapshot(source);
  const previous=await store.beginRun('weekly:2099-09-30T08:00:00.000Z','2099-09-30T08:00:00Z');
  await store.saveSnapshot(previous.id,match.id,match);
  await store.savePrediction({runId:previous.id,fixtureId:match.id,provider:'jev',matchSignature:JSON.stringify(match),prediction,completedAt:'2099-09-30T08:15:00Z'});
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2099-10-07T08:00:00Z')});
  try {
    const stats=await generateWeeklyPredictions(store,{jev:async()=>{throw new Error('must not run without fresh fixture data');}},'2099-10-07T08:00:00Z',async()=>{});
    assert.deepEqual(stats,{targeted:1,updated:0,failed:0});
    const live=(await response(fixturesHandler)).matches[0];
    assert.equal(live.forecastStates.jev.status,'succeeded');
    assert.equal(live.forecastStates.jev.availability,'retained');
    const view=await store.getFixtureView();
    assert.equal(view.providerPredictions[match.id].jev.runKey,'weekly:2099-09-30T08:00:00.000Z');
  } finally {t.mock.timers.reset();}
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
  assert.equal(forecastPanel(live,'openai',null,live.forecastStates.openai),'');
  assert.ok(!JSON.stringify(live).includes('private credential'));
});

dbtest('the weekly cron records missing credentials as failures for all five expected agents',async t=>{
  const source=baseline();source.predictions={};
  source.fixtures.updatedAt='2099-10-07T08:00:00Z';
  source.fixtures.matches[0]={...match,kickoff:'2099-10-08T12:00:00Z'};
  await store.importSnapshot(source);
  const saved=Object.fromEntries(['AI_GATEWAY_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','CRON_SECRET'].map(key=>[key,process.env[key]]));
  try {
    for(const key of Object.keys(saved))delete process.env[key];
    t.mock.timers.enable({apis:['Date'],now:Date.parse('2099-10-07T08:00:00Z')});
    const stats=await response(predictionsHandler);
    assert.equal(stats.failed,5);
    assert.equal(stats.updated,0);
    const live=(await response(fixturesHandler)).matches[0];
    for(const provider of ['jev','openai','claude','chatgpt','gemini']){
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
  assert.equal(forecastPanel(live,'openai',null,live.forecastStates.openai),'');
  assert.equal((await store.getRun(run.id)).attempts[0].status,'failed');
  let calls=0;
  const stats=await generateWeeklyPredictions(store,{openai:async()=>{calls++;}},'2099-10-08T08:00:00Z',async()=>{});
  assert.equal(stats.skipped,'outside weekly run window');
  assert.equal(calls,0);
  assert.equal((await store.getRun(run.id)).attempts[0].status,'expired');
});

dbtest('partial weekly success is visible immediately and only the failed provider retries to a fresh forecast',async t=>{
  const source=baseline();source.predictions={};
  source.fixtures.updatedAt='2099-10-07T08:00:00Z';
  source.fixtures.matches[0]={...match,kickoff:'2099-10-08T12:00:00Z'};
  await store.importSnapshot(source);
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2099-10-07T08:00:00Z')});
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
  assert.equal(forecastPanel(live,'openai',null,live.forecastStates.openai),'');
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
  t.mock.timers.reset();
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


dbtest('scoreboard includes prior seasons and excludes post-kickoff or ineligible selections',async()=>{
  const oldFixture={...match,id:81,kickoff:'2025-10-12T12:00:00Z'};
  const currentFixture={...match,id:82,kickoff:'2026-10-12T12:00:00Z'};
  const source=baseline();source.predictions={};source.results=[];source.fixtures.matches=[oldFixture,currentFixture];
  await store.importSnapshot(source);
  for(const [fixture,provider] of [[oldFixture,'jev'],[oldFixture,'openai'],[currentFixture,'jev']]){
    const generatedAt=fixture.id===81?'2025-10-11T09:00:00Z':'2026-10-11T09:00:00Z';
    const run=await store.beginRun(`history:${fixture.id}:${provider}`,generatedAt);
    await store.saveSnapshot(run.id,fixture.id,fixture);
    await store.recordAttempt({runId:run.id,fixtureId:fixture.id,provider,status:'started',attemptAt:generatedAt});
    assert.equal(await store.savePrediction({runId:run.id,fixtureId:fixture.id,provider,
      matchSignature:JSON.stringify(fixture),prediction:{...prediction,generatedAt},completedAt:generatedAt}),true);
  }
  await store.refreshFixtures({matches:[],raw:[oldFixture,currentFixture].map(fixture=>({
    id:fixture.id,event:2,team_h:1,team_a:2,kickoff_time:fixture.kickoff,finished:true,team_h_score:2,team_a_score:1,
  })),teams,source:source.fixtures.source,updatedAt:'2026-10-13T08:00:00Z'});
  let page=await store.getResultsPage();
  assert.equal(page.results.length,1);
  assert.equal(page.providerSummaries.jev.resolved,2);
  assert.equal(page.providerSummaries.openai.resolved,1);
  assert.equal(page.sharedComparison.resolved,0);
  await pool.query(`UPDATE "${schema}".result_predictions SET eligible=false,correct_outcome=NULL,correct_score=NULL WHERE fixture_id=82`);
  page=await store.getResultsPage();
  assert.equal(page.providerSummaries.jev.resolved,1);
  await pool.query(`UPDATE "${schema}".predictions SET generated_at='2025-10-12T12:00:00Z' WHERE fixture_id=81 AND provider='openai'`);
  page=await store.getResultsPage();
  assert.equal(page.providerSummaries.openai.resolved,0);
  assert.equal(page.sharedComparison.resolved,0);
  assert.equal(page.providerSummaries.openai.brierScore,null);
});


dbtest('score distributions and method tags survive persistence, API views and result evaluation without rewriting old versions',async()=>{
  await store.importSnapshot(baseline());
  const old=(await store.getPredictions())[11].prediction;
  assert.deepEqual(old,prediction);assert.equal(old.method,undefined);
  const forecast=parsePrediction(scoreAnswer({'1_1':.30,'2_1':.26,'1_0':.24,'0_1':.20},'1_1'));
  for(const provider of ['jev','openai']){
    const run=await store.beginRun(`result-first:${provider}`,forecast.generatedAt);
    await store.saveSnapshot(run.id,match.id,match);
    await store.recordAttempt({runId:run.id,fixtureId:match.id,provider,status:'started',attemptAt:forecast.generatedAt});
    const saved={...forecast,model:provider==='jev'?'typesafe-ai/jev':'gpt-6-luna'};
    assert.equal(await store.savePrediction({runId:run.id,fixtureId:match.id,provider,
      matchSignature:JSON.stringify(match),prediction:saved,completedAt:forecast.generatedAt}),true);
    const loaded=(await store.getProviderPredictions())[11][provider].prediction;
    assert.deepEqual(loaded,saved);
  }
  const fixtureView=await response(fixturesHandler);
  assert.equal(fixtureView.matches[0].predictions.jev.method,'score-distribution-result-first-v1');
  assert.deepEqual(fixtureView.matches[0].predictions.openai.scoreProbabilities,forecast.scoreProbabilities);
  await store.refreshFixtures({matches:[],raw:[{id:11,event:2,team_h:1,team_a:2,kickoff_time:match.kickoff,
    finished:true,team_h_score:2,team_a_score:1}],teams,source:baseline().fixtures.source,updatedAt:'2099-10-13T08:00:00Z'});
  const results=await store.getResultsPage();
  for(const provider of ['jev','openai']){
    const entry=results.results.find(result=>result.id===11).forecasts[provider];
    assert.equal(entry.correctOutcome,true);assert.equal(entry.correctScore,true);
    assert.equal(entry.prediction.method,forecast.method);
    assert.deepEqual(entry.prediction.scoreProbabilities,forecast.scoreProbabilities);
  }
  const originals=(await pool.query(`SELECT data FROM "${schema}".predictions WHERE fixture_id=11 AND provider='jev' ORDER BY generated_at,id`)).rows;
  assert.deepEqual(originals[0].data,old);assert.equal(originals.length,2);
});

dbtest('predictions remain visible after kickoff and in-progress refresh until a complete result arrives',async t=>{
  const kickoff='2026-10-11T12:00:00Z';
  const fixture={...match,kickoff};
  const source=baseline();source.fixtures.matches=[fixture];source.predictions[11].matchSignature=JSON.stringify(fixture);
  await store.importSnapshot(source);
  const run=await store.beginRun('visibility:openai','2026-10-11T09:00:00Z');
  await store.saveSnapshot(run.id,11,fixture);
  await store.recordAttempt({runId:run.id,fixtureId:11,provider:'openai',status:'started',attemptAt:'2026-10-11T09:00:00Z'});
  await store.savePrediction({runId:run.id,fixtureId:11,provider:'openai',matchSignature:JSON.stringify(fixture),prediction,completedAt:'2026-10-11T09:00:00Z'});
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-11T14:00:00Z')});
  const assertVisible=async()=>{
    const page=await response(fixturesHandler);
    assert.equal(page.matches.length,1,'match remains on Predictions until a result is stored');
    for(const provider of ['jev','openai'])assert.deepEqual(page.matches[0].predictions[provider].score,[2,1]);
    assert.equal((await store.getResultsPage()).results.length,0);
  };
  await assertVisible();
  // Simulate the previous release hiding a started match.
  await pool.query(`UPDATE "${schema}".fixtures SET upcoming=false,data=data || '{"fixtureStatus":"in_progress"}'::jsonb WHERE id=11`);
  await assertVisible();
  const raw={id:11,event:2,team_h:1,team_a:2,kickoff_time:kickoff,started:true,finished:false,team_h_score:1,team_a_score:0};
  await store.refreshFixtures({matches:[],raw:[raw],teams,source:source.fixtures.source,updatedAt:'2026-10-11T13:00:00Z'});
  await assertVisible();
  await store.refreshFixtures({matches:[],raw:[{...raw,finished:true,team_a_score:null}],teams,source:source.fixtures.source,updatedAt:'2026-10-11T13:30:00Z'});
  await assertVisible();
  await store.refreshFixtures({matches:[],raw:[{...raw,finished_provisional:true,team_h_score:2,team_a_score:1}],teams,source:source.fixtures.source,updatedAt:'2026-10-11T14:00:00Z'});
  assert.deepEqual((await response(fixturesHandler)).matches,[]);
  const result=(await store.getResultsPage()).results[0];
  assert.deepEqual(result.actualScore,[2,1]);
  for(const provider of ['jev','openai'])assert.deepEqual(result.forecasts[provider].prediction.score,[2,1]);
});

dbtest('all five agents survive the weekly job and appear in read APIs and completed evaluations',async()=>{
  const ids=['jev','openai','claude','chatgpt','gemini'];
  const source=baseline();source.predictions={};source.fixtures.updatedAt='2099-10-07T07:59:00Z';
  await store.importSnapshot(source);
  const seen=[];
  const providers=Object.fromEntries(ids.map(provider=>[provider,async input=>{
    seen.push(structuredClone(input));input.home.name='mutation';
    return {...prediction,model:provider,generatedAt:'2099-10-07T08:00:00Z'};
  }]));
  assert.deepEqual(await generateWeeklyPredictions(store,providers,'2099-10-07T08:00:00Z',async()=>{}),{targeted:1,updated:5,failed:0});
  assert.deepEqual(seen,ids.map(()=>match));
  const upcoming=await response(fixturesHandler);
  assert.deepEqual(upcoming.agents.map(agent=>agent.id),ids);
  assert.equal(upcoming.agents.find(agent=>agent.id==='openai').name,'Decisions API');
  assert.deepEqual(Object.keys(upcoming.matches[0].forecastStates),ids);
  assert.deepEqual(Object.keys(upcoming.providersConfigured),ids);
  for(const id of ids)assert.equal(upcoming.matches[0].predictions[id].model,id);
  await store.refreshFixtures({matches:[],teams,source:'test',updatedAt:'2099-10-12T15:00:00Z',raw:[{
    id:match.id,event:2,kickoff_time:match.kickoff,team_h:1,team_a:2,team_h_score:2,team_a_score:1,finished:true,
  }]});
  const completed=await response(resultsHandler);
  assert.deepEqual(completed.agents.map(agent=>agent.id),ids);
  assert.deepEqual(completed.results[0].missingProviders,[]);
  for(const id of ids){
    assert.equal(completed.results[0].forecasts[id].correctScore,true);
    assert.equal(completed.providerSummaries[id].resolved,1);
  }
  assert.equal(completed.sharedComparison.resolved,1);
  assert.deepEqual(completed.sharedComparison.providerIds,ids);
  assert.equal(completed.sharedComparison.oScoreDiagnostics.scope,'shared_all_agents');
  assert.equal(completed.sharedComparison.oScoreDiagnostics.resolved,1);
  assert.equal(completed.sharedComparison.oScoreDiagnostics.providerSummaries.jev.total,0);
  assert.equal(completed.sharedComparison.oScoreDiagnostics.providerSummaries.gemini.sampleCount,1);
});

dbtest('five-provider evidence flows through corrected results and O Score views without activating competition',async()=>{
  const ids=['jev','openai','claude','chatgpt','gemini'];
  const kickoff=['2099-10-09T12:00:00Z','2099-10-10T12:00:00Z','2099-10-11T12:00:00Z'];
  const matches=kickoff.map((date,index)=>({...structuredClone(match),id:101+index,gameweek:7,kickoff:date}));
  const source=baseline();source.fixtures={...source.fixtures,matches,updatedAt:'2099-10-07T07:59:00Z'};source.predictions={};source.results=[];
  await store.importSnapshot(source);
  const scoreGrid={
    101:{jev:[5,0],openai:[4,0],claude:[1,0],chatgpt:[2,2],gemini:[0,5]},
    102:{jev:[4,1],openai:[4,0],claude:null,chatgpt:null,gemini:[3,1]},
    103:{jev:null,openai:null,claude:null,chatgpt:null,gemini:null},
  };
  const evidence=[];
  const providers=Object.fromEntries(ids.map(id=>[id,async input=>{
    evidence.push({provider:id,matchId:input.id,input:structuredClone(input)});
    const score=scoreGrid[input.id][id];
    if(!score)throw new Error('mock provider unavailable');
    const outcome=score[0]===score[1]?'draw':score[0]>score[1]?'home':'away';
    return {outcome,score,probabilities:{home:.6,draw:.25,away:.15},model:id,generatedAt:'2099-10-07T08:00:00Z'};
  }]));
  assert.deepEqual(await generateWeeklyPredictions(store,providers,'2099-10-07T08:00:00Z',async()=>{}),{targeted:3,updated:8,failed:7});
  assert.equal(evidence.length,15);
  for(const m of matches){
    const copies=evidence.filter(item=>item.matchId===m.id).map(item=>item.input);
    assert.equal(copies.length,5);
    for(const copy of copies)assert.deepEqual(copy,m);
  }
  const completedRaw=matches.map((m,index)=>({id:m.id,event:7,kickoff_time:m.kickoff,team_h:1,team_a:2,team_h_score:[5,4,2][index],team_a_score:[0,1,2][index],finished:true}));
  await store.refreshFixtures({matches:[],teams,source:'test',updatedAt:'2099-10-12T15:00:00Z',raw:completedRaw});
  const api=await response(resultsHandler);
  assert.equal(api.competition.active,false);
  assert.equal(api.competition.includedFixtureBoundary,null);
  assert.deepEqual(api.agents.map(agent=>agent.id),ids);
  assert.equal(api.results.length,3);
  const scores=Object.fromEntries(ids.map(id=>[id,api.results.find(row=>row.id===101).oScores[id].value]));
  assert.deepEqual(scores,{jev:0,openai:1,claude:4,chatgpt:6,gemini:11});
  const allMissing=api.results.find(row=>row.id===103);
  assert.deepEqual(allMissing.actualScore,[2,2]);
  assert.deepEqual(allMissing.missingProviders,ids);
  assert.ok(ids.every(id=>allMissing.oScores[id].value===null));
  const fractional=api.results.find(row=>row.id===102);
  assert.equal(fractional.oScores.claude.source,'mean_assigned');
  assert.equal(fractional.oScores.claude.value,2/3);
  assert.equal(fractional.oScores.chatgpt.value,2/3);
  assert.equal(api.providerSummaries.jev.oScoreDiagnostics.sampleCount,2);
  assert.equal(api.providerSummaries.claude.oScoreDiagnostics.earnedCount,1);
  assert.equal(api.providerSummaries.claude.oScoreDiagnostics.meanAssignedCount,1);
  assert.equal(api.providerSummaries.claude.resolved,1);
  assert.equal(api.providerSummaries.claude.brierSampleCount,1);
  assert.equal(api.gameweeks.find(week=>week.gameweek===7).counts.completed,3);
  assert.equal(api.gameweeks.find(week=>week.gameweek===7).counts.remaining,0);
  assert.equal(api.gameweeks.find(week=>week.gameweek===7).oScoreSummaries.claude.sampleCount,2);
  assert.match(renderResultCard(allMissing),/Final score 2 : 2/);
  assert.match(renderResultCard(allMissing),/No prediction/);
  assert.match(renderResultCard(allMissing),/No earned O Score exists/);
  assert.doesNotMatch(renderResultCard(allMissing),/O Score<\/span><strong>0/);
  assert.equal(renderCompetitionStandings(api).active,false);
  assert.match(renderGameweekView(api).message,/Competition has not started/);
  const attemptCount=evidence.length;
  await response(resultsHandler);
  assert.equal(evidence.length,attemptCount,'read API must not invoke providers');

  const correctedRaw=completedRaw.map(row=>row.id===101?{...row,team_h_score:5,team_a_score:1}:row);
  await store.refreshFixtures({matches:[],teams,source:'test',updatedAt:'2099-10-13T15:00:00Z',raw:correctedRaw});
  const corrected=await response(resultsHandler);
  assert.equal(corrected.competition.active,false);
  assert.deepEqual(Object.fromEntries(ids.map(id=>[id,corrected.results.find(row=>row.id===101).oScores[id].value])),{jev:1,openai:2,claude:5,chatgpt:5,gemini:10});
  assert.equal(corrected.providerSummaries.claude.oScoreDiagnostics.total,17/3);
  assert.equal(corrected.gameweeks.find(week=>week.gameweek===7).oScoreSummaries.claude.total,17/3);
  assert.match(renderResultCard(corrected.results.find(row=>row.id===101)),/Final score 5 : 1/);

  const future={...structuredClone(match),id:104,gameweek:7,kickoff:'2099-10-15T12:00:00Z'};
  const futureRaw={id:104,event:7,kickoff_time:future.kickoff,team_h:1,team_a:2,team_h_score:null,team_a_score:null,started:false,finished:false,finished_provisional:false};
  await store.refreshFixtures({matches:[...matches,future],teams,source:'test',updatedAt:'2099-10-14T15:00:00Z',raw:[...correctedRaw,futureRaw]});
  assert.ok((await store.getFixtures()).matches.some(fixture=>fixture.id===104));

  const activated=await store.activateCompetition('2099-10-10T00:00:00Z');
  assert.equal(activated.active,true);
  assert.equal(activated.includedFixtureBoundary.timestamp,'2099-10-10T00:00:00.000Z');
  assert.equal((await store.activateCompetition('2099-10-11T00:00:00Z')).startedAt,'2099-10-10T00:00:00.000Z');
  const active=await response(resultsHandler);
  assert.equal(active.competition.active,true);
  assert.equal(active.competition.startedAt,'2099-10-10T00:00:00.000Z');
  assert.equal(active.competitionSummaries.jev.resolved,1);
  assert.equal(active.competitionSummaries.jev.sampleCount,1);
  assert.equal(active.competitionSummaries.jev.brierSampleCount,0);
  const activeWeek=active.gameweeks.find(week=>week.gameweek===7);
  assert.deepEqual(activeWeek.competitionCounts,{fixtures:3,completed:2,remaining:1,cancelled:0});
  assert.equal(activeWeek.competitionSummaries.jev.resolved,1);
  assert.equal(activeWeek.competitionSummaries.jev.brierSampleCount,0);

  // A postponed fixture can temporarily lose its kickoff and event. Preserve
  // it as a potentially eligible member so finished fixtures do not settle
  // the active gameweek or announce a winner prematurely.
  await store.refreshFixtures({matches:[{...future,kickoff:null,gameweek:null}],teams,source:'test',
    updatedAt:'2099-10-15T15:00:00Z',raw:[...correctedRaw,{...futureRaw,event:null,kickoff_time:null}]});
  assert.equal((await store.getFixtures()).matches.find(fixture=>fixture.id===104).kickoff,null);
  const postponed=await response(resultsHandler);
  const postponedWeek=postponed.gameweeks.find(week=>week.gameweek===7);
  assert.deepEqual(postponedWeek.competitionCounts,{fixtures:3,completed:2,remaining:1,cancelled:0});
  assert.equal(postponedWeek.competitionComplete,false);
  assert.equal(postponedWeek.competitionSummaries.jev.resolved,1);
  assert.match(renderGameweekView(postponed).message,/provisional/i);
  assert.doesNotMatch(renderGameweekView(postponed).message,/winner/i);

  const rescheduledAndCompleted={...futureRaw,event:7,kickoff_time:'2099-10-16T12:00:00Z',
    finished:true,team_h_score:2,team_a_score:0};
  await store.refreshFixtures({matches:[],teams,source:'test',updatedAt:'2099-10-16T13:00:00Z',raw:[...correctedRaw,rescheduledAndCompleted]});
  const settled=await response(resultsHandler);
  const settledWeek=settled.gameweeks.find(week=>week.gameweek===7);
  assert.deepEqual(settledWeek.competitionCounts,{fixtures:3,completed:3,remaining:0,cancelled:0});
  assert.equal(settledWeek.competitionComplete,true);
});

dbtest('fixture availability treats the current activation run as fresh',async()=>{
  const now=new Date();
  const startedAt=new Date(now.getTime()-60_000).toISOString();
  const kickoff=new Date(now.getTime()+5*24*60*60*1000).toISOString();
  const upcoming={...structuredClone(match),kickoff};
  const source=baseline();source.fixtures={...source.fixtures,matches:[upcoming],updatedAt:now.toISOString()};source.predictions={};source.results=[];
  await store.importSnapshot(source);
  await store.activateCompetition(startedAt);
  const result=await runCompetition(store,{jev:async()=>({...prediction,generatedAt:new Date(now.getTime()+1_000).toISOString()})},startedAt,now,async()=>{},()=>new Date(now.getTime()+2_000));
  assert.equal(result.updated,1);
  const fixtureView=await response(fixturesHandler);
  assert.equal(fixtureView.matches[0].forecastStates.jev.availability,'fresh');
});

test('activation and manual prediction routes require an explicit secret and reject unauthorized requests',async()=>{
  const secret=process.env.CRON_SECRET;
  const backend=process.env.PERSISTENCE_BACKEND;
  const invoke=async(handler,request)=>{
    let body;const res={setHeader(){},end(text){body=JSON.parse(text);}};
    await handler(request,res);return {status:res.statusCode,body};
  };
  try{
    delete process.env.CRON_SECRET;
    assert.equal((await invoke(activateHandler,{method:'POST',headers:{}})).status,503);
    assert.equal((await invoke(manualPredictionHandler,{method:'POST',headers:{}})).status,503);
    process.env.CRON_SECRET='test-only-secret';
    assert.equal((await invoke(activateHandler,{method:'POST',headers:{authorization:'Bearer wrong'}})).status,401);
    assert.equal((await invoke(manualPredictionHandler,{method:'POST',headers:{authorization:'Bearer wrong'}})).status,401);
  }finally{
    if(secret===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=secret;
    if(backend===undefined)delete process.env.PERSISTENCE_BACKEND;else process.env.PERSISTENCE_BACKEND=backend;
  }
});

dbtest('failed paid responses retain usage per attempt and retry without replacing successful agents or old forecasts',async()=>{
  const source=baseline();source.fixtures.updatedAt='2099-10-07T07:59:00Z';await store.importSnapshot(source);
  let claudeCalls=0,geminiCalls=0;
  const metadata={model:'claude-opus-5-5',usage:{inputTokens:100,outputTokens:200},cost:{amount:.0044,currency:'USD',estimated:true}};
  const inputs=[];
  const providers={claude:async input=>{
    inputs.push(structuredClone(input));
    if(++claudeCalls===1)throw Object.assign(new Error('Private refusal text'),{predictionMetadata:metadata});
    return {...prediction,...metadata,generatedAt:'2099-10-07T08:15:00Z'};
  },gemini:async()=>{geminiCalls++;return {...prediction,model:'gemini-3.1-pro-preview',generatedAt:'2099-10-07T08:00:00Z'};}};
  assert.deepEqual(await generateWeeklyPredictions(store,providers,'2099-10-07T08:00:00Z',async()=>{}),{targeted:1,updated:1,failed:1});
  let live=(await response(fixturesHandler)).matches[0];
  assert.equal(live.forecastStates.claude.status,'failed');assert.equal(live.predictions.claude,undefined);
  assert.equal(live.predictions.jev.generatedAt,prediction.generatedAt);
  const run=await store.beginRun('weekly:2099-10-07T08:00:00.000Z');
  let state=await store.getRun(run.id);
  assert.equal(state.attemptHistory.find(attempt=>attempt.provider==='claude').metadata.cost.amount,.0044);
  assert.equal((await generateWeeklyPredictions(store,providers,'2099-10-07T08:14:59Z',async()=>{})).updated,0);
  assert.deepEqual(await generateWeeklyPredictions(store,providers,'2099-10-07T08:15:00Z',async()=>{}),{targeted:1,updated:1,failed:0});
  assert.equal(claudeCalls,2);assert.equal(geminiCalls,1);assert.deepEqual(inputs,[match,match]);
  state=await store.getRun(run.id);
  const history=state.attemptHistory.filter(attempt=>attempt.provider==='claude');
  assert.deepEqual(history.map(attempt=>[attempt.attemptNumber,attempt.status]),[[1,'failed'],[2,'succeeded']]);
  assert.ok(history.every(attempt=>attempt.metadata.model==='claude-opus-5-5'));
  assert.equal(state.predictions.find(entry=>entry.provider==='claude').data.usage.inputTokens,100);
  assert.ok(!JSON.stringify(state).includes('Private refusal text'));
});

dbtest('the production cron wires all five HTTP adapters to identical evidence and retries only the invalid agent',async t=>{
  const source=baseline();source.predictions={};source.fixtures.updatedAt='2099-10-07T08:00:00Z';
  await store.importSnapshot(source);
  const names=['AI_GATEWAY_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','CRON_SECRET'];
  const saved=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  let claudeCalls=0;
  const evidence=[];
  try {
    for(const name of names)process.env[name]='test-only-key';delete process.env.CRON_SECRET;
    t.mock.timers.enable({apis:['Date'],now:Date.parse('2099-10-07T08:00:00Z')});
    t.mock.method(globalThis,'fetch',async(url,options)=>{
      const body=JSON.parse(options.body),answer=scoreAnswer({'1_1':.30,'2_1':.26,'1_0':.24,'0_1':.20},'1_1');
      const text=JSON.stringify({scoreProbabilities:answer.answers.score.probabilities});
      if(url.endsWith('/evaluate')) {evidence.push(body.state);return Response.json(answer);}
      if(url.endsWith('/decisions')) {
        evidence.push(JSON.parse(body.input));
        return Response.json({model:'gpt-6-luna',answers:[{name:'score',type:'choice',choice:'1_1',
          probabilities:Object.entries(answer.answers.score.probabilities).map(([value,probability])=>({value,probability}))}]});
      }
      if(url.endsWith('/messages')) {
        evidence.push(JSON.parse(body.messages[0].content).evidence);claudeCalls++;
        return Response.json({model:'claude-opus-5-5',stop_reason:'end_turn',content:[{type:'text',text:claudeCalls===1?'{}':text}],usage:{input_tokens:100,output_tokens:200}});
      }
      if(url.endsWith('/responses')) {
        evidence.push(JSON.parse(body.input).evidence);
        return Response.json({model:'gpt-6.1-sol',status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]});
      }
      assert.ok(url.endsWith(':generateContent'));
      evidence.push(JSON.parse(body.contents[0].parts[0].text).evidence);
      return Response.json({modelVersion:'gemini-3.1-pro-preview',candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]});
    });
    const first=await response(predictionsHandler);
    assert.equal(first.updated,4);assert.equal(first.failed,1);
    const live=(await response(fixturesHandler)).matches[0];
    for(const id of ['jev','openai','chatgpt','gemini']){
      assert.equal(live.predictions[id].outcome,'home');assert.deepEqual(live.predictions[id].score,[2,1]);
      assert.equal(Object.keys(live.predictions[id].scoreProbabilities).length,49);
    }
    assert.equal(live.predictions.claude,undefined);assert.equal(live.forecastStates.claude.attemptCount,1);
    assert.ok(evidence.every(input=>JSON.stringify(input)===JSON.stringify(evidence[0])));
    t.mock.timers.setTime(Date.parse('2099-10-07T08:15:00Z'));
    const retry=await response(predictionsHandler);
    assert.equal(retry.updated,1);assert.equal(retry.failed,0);assert.equal(evidence.length,6);
    assert.deepEqual(evidence[5],evidence[0]);
    const final=await response(fixturesHandler);
    assert.equal(final.matches[0].predictions.claude.model,'claude-opus-5-5');
    assert.ok(!JSON.stringify(final).includes('test-only-key'));
  } finally {
    t.mock.timers.reset();
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});

dbtest('the five-agent migration preserves prior forecasts and evaluations without inventing attempt history',async()=>{
  await store.importSnapshot(baseline());
  const legacy=await store.beginRun('legacy-active:11');
  assert.deepEqual((await store.getRun(legacy.id)).attemptHistory,[]);
  await store.refreshFixtures({matches:[],teams,source:'test',updatedAt:'2099-10-12T15:00:00Z',raw:[{
    id:match.id,event:2,kickoff_time:match.kickoff,team_h:1,team_a:2,team_h_score:2,team_a_score:1,finished:true,
  }]});
  const before=await store.getResultsPage();
  const legacyBefore=await store.getResults();
  await pool.query(`DROP TABLE "${schema}".attempt_history;
    ALTER TABLE "${schema}".result_predictions DROP CONSTRAINT result_predictions_provider_check;
    ALTER TABLE "${schema}".result_predictions ADD CONSTRAINT result_predictions_provider_check CHECK(provider IN ('jev','openai'));
    DELETE FROM "${schema}".schema_migrations WHERE version='003-five-agents'`);
  assert.deepEqual(await runSchemaMigrations(pool,schema),{applied:['003-five-agents'],registered:[]});
  assert.deepEqual(await store.getResultsPage(),before);
  assert.deepEqual(await store.getResults(),legacyBefore);
  assert.deepEqual(await runSchemaMigrations(pool,schema),{applied:[],registered:[]});
});

dbtest('a slow agent does not block other agent successes and the weekly job limits concurrent requests',async()=>{
  const source=baseline();source.predictions={};source.fixtures.updatedAt='2099-10-07T07:59:00Z';
  source.fixtures.matches=[match,{...match,id:12},{...match,id:13}];await store.importSnapshot(source);
  let release,active=0,maximum=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const providers=Object.fromEntries(['jev','openai','claude','chatgpt','gemini'].map(id=>[id,async()=>{
    active++;maximum=Math.max(maximum,active);
    if(id==='jev')await gate;
    else await new Promise(resolve=>setTimeout(resolve,5));
    active--;return {...prediction,model:id,generatedAt:'2099-10-07T08:00:00Z'};
  }]));
  const job=generateWeeklyPredictions(store,providers,'2099-10-07T08:00:00Z',async()=>{});
  try {
    let completed=false;
    for(let attempt=0;attempt<100;attempt++){
      const live=(await response(fixturesHandler)).matches[0];
      if(['openai','claude','chatgpt','gemini'].every(id=>live.predictions[id])){completed=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(completed,true);assert.ok(maximum<=6);assert.ok(maximum>1);
  } finally {release();await job;}
  const live=await response(fixturesHandler);
  assert.ok(live.matches.every(fixture=>Object.keys(fixture.predictions).length===5));
});
