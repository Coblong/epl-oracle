import test from 'node:test';
import assert from 'node:assert/strict';
import {competitionGameweekStandings,summarizeGameweeks} from '../gameweek-leaderboard.mjs';

const agents=['jev','openai','claude','chatgpt','gemini'];
const forecast=(score,outcome='home')=>({score,outcome,probabilities:{home:.6,draw:.25,away:.15}});

test('a gameweek keeps its postponed fixture provisional until it has a confirmed result',()=>{
  const weeks=summarizeGameweeks([
    {id:1,gameweek:1,status:'completed',actualScore:[2,1],forecasts:{jev:forecast([2,1])}},
    {id:2,gameweek:1,status:'awaiting_rescheduling',actualScore:null,forecasts:{jev:forecast([1,0])}},
  ],agents);
  assert.deepEqual(weeks[0].counts,{fixtures:2,completed:1,remaining:1,cancelled:0});
  assert.equal(weeks[0].complete,false);
  assert.equal(weeks[0].providerSummaries.jev.resolved,1);
  assert.equal(weeks[0].oScoreSummaries.jev.total,0);
});

test('a settled gameweek excludes cancelled fixtures and assigns missing O Scores from earned scores',()=>{
  const weeks=summarizeGameweeks([
    {id:1,gameweek:2,status:'completed',actualScore:[2,1],forecasts:{jev:forecast([2,1]),openai:forecast([3,1]),claude:forecast([1,1],'draw')}},
    {id:2,gameweek:2,status:'cancelled',actualScore:null,forecasts:{}},
    {id:3,gameweek:2,status:'completed',cancelled:true,actualScore:[0,0],forecasts:{jev:forecast([0,0])}},
  ],agents);
  assert.deepEqual(weeks[0].counts,{fixtures:1,completed:1,remaining:0,cancelled:2});
  assert.equal(weeks[0].complete,true);
  assert.equal(weeks[0].oScoreSummaries.jev.total,0);
  assert.equal(weeks[0].oScoreSummaries.openai.total,1);
  assert.equal(weeks[0].oScoreSummaries.claude.total,2);
  assert.equal(weeks[0].oScoreSummaries.chatgpt.sampleCount,1);
  assert.equal(weeks[0].oScoreSummaries.chatgpt.meanAssignedCount,1);
});

test('a completed competition round shares a tie and never ranks disabled historical totals',()=>{
  const agents=[{id:'jev',name:'Jev'},{id:'openai',name:'Decisions API'},{id:'claude',name:'Claude'}];
  const week={complete:true,competitionSummaries:{
    jev:{total:1.5,sampleCount:1},openai:{total:1.5+5e-13,sampleCount:1},claude:{total:2,sampleCount:1},
  }};
  assert.deepEqual(competitionGameweekStandings(week,{active:false,includedFixtureBoundary:null},agents),[]);
  assert.deepEqual(competitionGameweekStandings(week,{active:true,includedFixtureBoundary:42},agents)
    .map(({id,rank})=>[id,rank]),[['jev',1],['openai',1],['claude',3]]);
  assert.deepEqual(competitionGameweekStandings({...week,complete:false},{active:true,includedFixtureBoundary:42},agents)
    .map(({id,rank})=>[id,rank]),[['jev',1],['openai',1],['claude',3]]);
});

test('a round with only cancelled fixtures has no scored winner sample',()=>{
  const [week]=summarizeGameweeks([{id:9,gameweek:3,status:'cancelled',actualScore:null,forecasts:{}}],agents);
  assert.equal(week.complete,false);
  assert.deepEqual(week.counts,{fixtures:0,completed:0,remaining:0,cancelled:1});
  assert.equal(week.oScoreSummaries.jev.sampleCount,0);
});

test('a changed official gameweek assignment places the fixture in its new round',()=>{
  const weeks=summarizeGameweeks([
    {id:1,gameweek:5,status:'completed',actualScore:[1,0],forecasts:{jev:forecast([1,0])}},
    {id:2,gameweek:6,status:'upcoming',actualScore:null,forecasts:{}},
  ],agents);
  assert.deepEqual(weeks.map(week=>[week.gameweek,week.counts.fixtures]),[[5,1],[6,1]]);
});

test('gameweek Brier summaries use the same all-agent probability sample',()=>{
  const [week]=summarizeGameweeks([
    {id:1,gameweek:7,status:'completed',actualScore:[2,1],forecasts:{jev:forecast([2,1]),openai:forecast([2,1])}},
    {id:2,gameweek:7,status:'completed',actualScore:[1,0],forecasts:{jev:forecast([1,0]),openai:{...forecast([1,0]),probabilities:{home:.6,draw:.2,away:.1}}}},
  ],['jev','openai']);
  assert.equal(week.providerSummaries.jev.resolved,2);
  assert.equal(week.sharedComparison.providerSummaries.jev.brierSampleCount,1);
  assert.equal(week.sharedComparison.providerSummaries.openai.brierSampleCount,1);
});
