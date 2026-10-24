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
