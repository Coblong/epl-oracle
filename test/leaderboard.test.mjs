import test from 'node:test';
import assert from 'node:assert/strict';
import {competitionLeaderboard,renderCompetitionStandings,renderHistoricalLeaderboard} from '../leaderboard.mjs';

const agents=[
  {id:'jev',name:'Jev'},
  {id:'openai',name:'Decisions API'},
  {id:'claude',name:'Claude'},
  {id:'chatgpt',name:'ChatGPT'},
  {id:'gemini',name:'Gemini'},
];

test('an active supplied competition cohort ranks O Score ascending and shares ties',()=>{
  const view=competitionLeaderboard({
    competition:{active:true,includedFixtureBoundary:42},agents,
    competitionSummaries:{
      jev:{total:4+1.5e-12,sampleCount:2,average:2},
      openai:{total:4,sampleCount:2,average:2},
      claude:{total:4+5e-13,sampleCount:2,average:2},
      chatgpt:{total:9,sampleCount:2,average:4.5},
      gemini:{total:0,sampleCount:0,average:null},
    },
  });
  assert.equal(view.active,true);
  assert.deepEqual(view.rows.map(({id,rank})=>[id,rank]),[
    ['openai',1],['claude',1],['jev',3],['chatgpt',4],
  ]);
});

test('disabled or boundary-less competition never ranks historical diagnostics',()=>{
  for(const competition of [
    {active:false,includedFixtureBoundary:null},
    {active:true,includedFixtureBoundary:null},
  ]){
    const view=competitionLeaderboard({competition,agents,competitionSummaries:{
      jev:{total:1,sampleCount:1},
    }});
    assert.equal(view.active,false);
    assert.deepEqual(view.rows,[]);
  }
});

test('an empty O Score sample cannot become a competition winner',()=>{
  const view=competitionLeaderboard({
    competition:{active:true,includedFixtureBoundary:42},agents,
    competitionSummaries:Object.fromEntries(agents.map(agent=>[agent.id,{total:0,sampleCount:0,average:null}])),
  });
  assert.equal(view.active,true);
  assert.deepEqual(view.rows,[]);
});

test('historical diagnostics show all agents without implying ranks or mixing scopes',()=>{
  const diagnostics={submittedCount:1,missingCount:1,earnedCount:1,meanAssignedCount:1,sampleCount:2,total:0.5,average:0.25};
  const summary={resolved:2,outcomeCorrect:1,outcomeAccuracy:.5,scoreCorrect:0,scoreAccuracy:0,brierScore:.4,brierSampleCount:1};
  const full=renderHistoricalLeaderboard({agents,providerSummaries:Object.fromEntries(agents.map(agent=>[
    agent.id,{...summary,oScoreDiagnostics:{scope:'full_history',...diagnostics}},
  ]))},'full');
  assert.match(full.caption,/Full history/);
  assert.match(full.rows,/1 submitted · 1 missing/);
  assert.match(full.rows,/1 earned · 1 mean-assigned · 2 scored/);
  assert.match(full.rows,/Decisions API/);
  assert.doesNotMatch(full.rows,/<td>1<\/td>/);

  const shared=renderHistoricalLeaderboard({agents,sharedComparison:{
    resolved:1,providerSummaries:Object.fromEntries(agents.map(agent=>[agent.id,{...summary,resolved:1}])),
    oScoreDiagnostics:{scope:'shared_all_agents',providerSummaries:Object.fromEntries(agents.map(agent=>[
      agent.id,{submittedCount:1,missingCount:0,earnedCount:1,meanAssignedCount:0,sampleCount:1,total:1.5,average:1.5},
    ]))},
  }},'shared');
  assert.match(shared.caption,/all 5 agents/);
  assert.match(shared.rows,/1 submitted · 0 missing/);
  assert.match(shared.rows,/1 earned · 0 mean-assigned · 1 scored/);
  assert.match(shared.rows,/1\.50/);
  assert.doesNotMatch(shared.rows,/1 earned · 1 mean-assigned · 2 scored/);
});

test('historical empty scope keeps five agents and explains the missing sample',()=>{
  const rendered=renderHistoricalLeaderboard({agents,providerSummaries:{}},'full');
  assert.equal(rendered.hasSamples,false);
  assert.match(rendered.rows,/No completed matches have eligible forecasts/);
  assert.doesNotMatch(rendered.rows,/0\.000/);
  for(const agent of agents)assert.match(rendered.rows,new RegExp(agent.name));
});

test('the shipped competition state stays disabled and never ranks historical summaries',()=>{
  const rendered=renderCompetitionStandings({
    agents,competition:{active:false,includedFixtureBoundary:null},
    providerSummaries:{jev:{oScoreDiagnostics:{total:1,sampleCount:1}}},
  });
  assert.equal(rendered.active,false);
  assert.equal(rendered.rows,'');
  assert.equal(rendered.message,'The competition has not started. Historical statistics are shown below.');
});

test('active standings render competition-scope accuracy and Brier denominators beside O Score',()=>{
  const summary={total:1.5,average:1.5,earnedCount:1,meanAssignedCount:0,sampleCount:1,
    resolved:1,outcomeCorrect:1,outcomeAccuracy:1,scoreCorrect:0,scoreAccuracy:0,
    brierScore:.245,brierSampleCount:1};
  const rendered=renderCompetitionStandings({
    competition:{active:true,includedFixtureBoundary:'2026-10-24T00:00:00Z'},agents,
    competitionSummaries:Object.fromEntries(agents.map(agent=>[agent.id,summary])),
  });
  assert.equal(rendered.active,true);
  assert.match(rendered.message,/active competition cohort/);
  assert.match(rendered.rows,/<td>1<\/td><th scope="row">Jev<\/th>/);
  assert.match(rendered.rows,/1\.500/);
  assert.match(rendered.rows,/100%<small>1 of 1 forecasts/);
  assert.match(rendered.rows,/0\.245<small>1 probability samples/);
});
