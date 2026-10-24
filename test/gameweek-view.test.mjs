import test from 'node:test';
import assert from 'node:assert/strict';
import {renderGameweekView} from '../gameweek-view.mjs';

const agents=[{id:'jev',name:'Jev'},{id:'openai',name:'Decisions API'},{id:'claude',name:'Claude'}];
const summary=(total)=>({total,average:total,resolved:1,outcomeCorrect:1,outcomeAccuracy:1,
  scoreCorrect:0,scoreAccuracy:0,brierScore:.245,brierSampleCount:1});
const competitionSummary=total=>({...summary(total),sampleCount:1});
const week={gameweek:2,counts:{fixtures:3,completed:1,remaining:2,cancelled:1},complete:false,
  providerSummaries:{jev:summary(1),openai:summary(1),claude:summary(1)},
  oScoreSummaries:Object.fromEntries(agents.map(agent=>[agent.id,{total:1.5,average:1.5,submittedCount:1,missingCount:0,
    earnedCount:1,meanAssignedCount:0,sampleCount:1}]))};

test('disabled gameweek history shows completed and remaining counts without ranks or winner claims',()=>{
  const view=renderGameweekView({agents,competition:{active:false,includedFixtureBoundary:null},gameweeks:[week]});
  assert.equal(view.selectedGameweek,2);
  assert.match(view.message,/Competition has not started/);
  assert.match(view.message,/1 completed, 2 remaining, 1 cancelled/);
  assert.doesNotMatch(view.headers,/RANK/);
  assert.match(view.rows,/1\.500/);
  assert.doesNotMatch(view.message,/winner/i);
});

test('active unfinished gameweeks show provisional standings but do not name a winner',()=>{
  const activeWeek={...week,competitionSummaries:Object.fromEntries(agents.map(agent=>[agent.id,competitionSummary(1.5)]))};
  const view=renderGameweekView({agents,competition:{active:true,includedFixtureBoundary:42},gameweeks:[activeWeek]});
  assert.match(view.message,/Provisional standings/);
  assert.match(view.headers,/RANK/);
  assert.doesNotMatch(view.message,/winner/i);
  assert.equal((view.rows.match(/<td>1<\/td>/g)||[]).length,3);
});

test('active rows follow scoped rank order and use scoped coverage counts',()=>{
  const activeSummaries={
    jev:{...competitionSummary(4),submittedCount:1,missingCount:2,earnedCount:1,meanAssignedCount:2,sampleCount:3},
    openai:{...competitionSummary(1),submittedCount:3,missingCount:0,earnedCount:3,meanAssignedCount:0,sampleCount:3},
    claude:{...competitionSummary(2),submittedCount:2,missingCount:1,earnedCount:2,meanAssignedCount:1,sampleCount:3},
  };
  const historicalSummaries=Object.fromEntries(agents.map(agent=>[agent.id,{total:0,average:0,submittedCount:99,
    missingCount:98,earnedCount:97,meanAssignedCount:96,sampleCount:95}]));
  const activeWeek={...week,oScoreSummaries:historicalSummaries,competitionSummaries:activeSummaries};
  const view=renderGameweekView({agents,competition:{active:true,includedFixtureBoundary:42},gameweeks:[activeWeek]});

  assert.ok(view.rows.indexOf('<th scope="row">Decisions API</th>')<view.rows.indexOf('<th scope="row">Claude</th>'));
  assert.ok(view.rows.indexOf('<th scope="row">Claude</th>')<view.rows.indexOf('<th scope="row">Jev</th>'));
  assert.match(view.rows,/3 submitted · 0 missing<\/small><small>3 earned · 0 mean-assigned · 3 scored/);
  assert.match(view.rows,/2 submitted · 1 missing<\/small><small>2 earned · 1 mean-assigned · 3 scored/);
  assert.match(view.rows,/1 submitted · 2 missing<\/small><small>1 earned · 2 mean-assigned · 3 scored/);
  assert.doesNotMatch(view.rows,/99 submitted|98 missing|95 scored/);
});

test('active unranked agents have no fabricated coverage when only one agent has a sample',()=>{
  const activeWeek={...week,complete:true,counts:{fixtures:1,completed:1,remaining:0,cancelled:0},
    competitionSummaries:{jev:{...competitionSummary(2),submittedCount:1,missingCount:0,earnedCount:1,
      meanAssignedCount:0,sampleCount:1}}};
  const view=renderGameweekView({agents,competition:{active:true,includedFixtureBoundary:42},gameweeks:[activeWeek]});

  assert.match(view.message,/Gameweek 2 winner: Jev/);
  assert.match(view.rows,/2\.000<small>1 submitted · 0 missing<\/small><small>1 earned · 0 mean-assigned · 1 scored/);
  assert.match(view.rows,/Jev[\s\S]*<\/tr><tr><td>—<\/td><th scope="row">Decisions API<\/th><td>—<small>0 submitted · 0 missing<\/small><small>0 earned · 0 mean-assigned · 0 scored/);
  assert.match(view.rows,/Claude<\/th><td>—<small>0 submitted · 0 missing/);
});

test('a completed all-missing active round has no score or winner',()=>{
  const activeWeek={...week,complete:true,counts:{fixtures:1,completed:1,remaining:0,cancelled:0},
    competitionSummaries:Object.fromEntries(agents.map(agent=>[agent.id,{sampleCount:0}]))};
  const view=renderGameweekView({agents,competition:{active:true,includedFixtureBoundary:42},gameweeks:[activeWeek]});

  assert.match(view.message,/No agent has an O Score sample/);
  assert.doesNotMatch(view.message,/winner/i);
  assert.equal((view.rows.match(/<td>—<\/td>/g)||[]).length,agents.length);
  assert.equal((view.rows.match(/0 submitted · 0 missing/g)||[]).length,agents.length);
});

test('settled active gameweeks name joint winners and current rounds are selected by default',()=>{
  const weeks=[{...week,gameweek:1,counts:{fixtures:1,completed:1,remaining:0,cancelled:0},complete:true,
      competitionSummaries:{jev:competitionSummary(1),openai:competitionSummary(1),claude:competitionSummary(2)}},
    {...week,gameweek:2,counts:{fixtures:2,completed:1,remaining:1,cancelled:0},complete:false,
      competitionSummaries:{jev:competitionSummary(3),openai:competitionSummary(2),claude:competitionSummary(4)}}];
  const view=renderGameweekView({agents,competition:{active:true,includedFixtureBoundary:42},gameweeks:weeks});
  assert.equal(view.selectedGameweek,2);
  assert.match(view.options,/value="2" selected/);
  assert.match(view.message,/Provisional standings/);
  const settled=renderGameweekView({agents,competition:{active:true,includedFixtureBoundary:42},gameweeks:weeks},1);
  assert.match(settled.message,/Gameweek 1 winners: Jev and Decisions API/);
});

test('empty gameweek history has a clear state and no fabricated scores',()=>{
  const view=renderGameweekView({agents,competition:{active:false,includedFixtureBoundary:null},gameweeks:[]});
  assert.equal(view.selectedGameweek,null);
  assert.match(view.rows,/No current-season gameweek data/);
  assert.doesNotMatch(view.rows,/0\.000/);
});
