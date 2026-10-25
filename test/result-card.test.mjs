import test from 'node:test';
import assert from 'node:assert/strict';
import {renderResultCard,resultsCompetitionNotice} from '../result-card.mjs';

const result={id:701,status:'completed',gameweek:7,kickoff:'2026-10-18T16:30:00.000Z',
  home:{name:'Arsenal'},away:{name:'Chelsea'},actualScore:[3,1],actualOutcome:'home',
  forecasts:{jev:{prediction:{outcome:'home',score:[3,1],generatedAt:'2026-10-17T12:00:00.000Z',
    model:'jev-v2',probabilities:{home:.7,draw:.2,away:.1}},correctOutcome:true,correctScore:true}},
  oScores:{jev:{value:0,source:'earned',homeGoalError:0,awayGoalError:0,resultPenalty:0}}};

test('completed results show the actual score once and ordered agent predictions with earned O Score',()=>{
  const html=renderResultCard(result);

  assert.match(html,/GAMEWEEK 7/);
  assert.match(html,/Arsenal/);
  assert.match(html,/Chelsea/);
  assert.match(html,/3 : 1/);
  assert.match(html,/Jev[\s\S]*Decisions API[\s\S]*Claude[\s\S]*ChatGPT[\s\S]*Gemini/);
  assert.match(html,/Arsenal win/);
  assert.match(html,/Result ✓/);
  assert.match(html,/Exact ✓/);
  assert.match(html,/O Score/);
  assert.match(html,/O Score<\/span><strong>0<\/strong><small>Earned/);
  assert.match(html,/Home-goal error<\/dt><dd>0/);
  assert.match(html,/Away-goal error<\/dt><dd>0/);
  assert.match(html,/Result penalty<\/dt><dd>0/);
  assert.match(html,/Brier score: 0\.140/);
});

test('missing forecasts show no scoreline and identify a mean-assigned O Score',()=>{
  const missing={...result,forecasts:{jev:result.forecasts.jev},oScores:{
    jev:result.oScores.jev,
    openai:{value:1.5,source:'mean_assigned',homeGoalError:null,awayGoalError:null,resultPenalty:null},
    claude:{value:null,source:'unavailable',homeGoalError:null,awayGoalError:null,resultPenalty:null},
  }};
  const html=renderResultCard(missing);

  assert.match(html,/No prediction/);
  assert.doesNotMatch(html,/predicted score 0 : 0/);
  assert.match(html,/1\.5<\/strong><small>Other agents' mean/);
  assert.match(html,/mean of earned O Scores on this match/);
  assert.match(html,/No earned O Score exists for this match/);
});

test('all-missing and cancelled matches keep actual status visible without awarding scores',()=>{
  const unavailable=Object.fromEntries(['jev','openai','claude','chatgpt','gemini'].map(id=>[id,
    {value:null,source:'unavailable',homeGoalError:null,awayGoalError:null,resultPenalty:null}]));
  const allMissing=renderResultCard({...result,forecasts:{},oScores:unavailable});
  assert.match(allMissing,/Final score 3 : 1/);
  assert.doesNotMatch(allMissing,/O Score<\/span><strong>0\.000/);
  assert.equal((allMissing.match(/No prediction/g)||[]).length,5);

  const cancelled=renderResultCard({...result,status:'cancelled',actualScore:null,forecasts:{},oScores:unavailable});
  assert.match(cancelled,/Cancelled fixture/);
  assert.match(cancelled,/Cancelled fixtures are not scored/);
  assert.doesNotMatch(cancelled,/O Score<\/span><strong>0\.000/);
});

test('official result corrections update actual scores and server-assigned O Scores',()=>{
  const correctedForecasts={
    jev:{prediction:{outcome:'home',score:[2,1]},correctOutcome:true,correctScore:true},
    openai:{prediction:{outcome:'home',score:[3,1]},correctOutcome:true,correctScore:false},
  };
  const first=renderResultCard({...result,actualScore:[2,1],forecasts:correctedForecasts,oScores:{
    jev:{value:0,source:'earned'},openai:{value:1,source:'earned'},claude:{value:.5,source:'mean_assigned'},
  }});
  const corrected=renderResultCard({...result,actualScore:[4,1],forecasts:correctedForecasts,oScores:{
    jev:{value:2,source:'earned'},openai:{value:1,source:'earned'},claude:{value:1.5,source:'mean_assigned'},
  }});

  assert.match(first,/Final score 2 : 1/);
  assert.match(first,/0\.5<\/strong><small>Other agents' mean/);
  assert.match(corrected,/Final score 4 : 1/);
  assert.match(corrected,/2<\/strong><small>Earned/);
  assert.match(corrected,/1\.5<\/strong><small>Other agents' mean/);
});

test('invalid probabilities do not produce a Brier score and disabled history is labeled',()=>{
  const invalid={...result,forecasts:{jev:{...result.forecasts.jev,prediction:{...result.forecasts.jev.prediction,
    probabilities:{home:.3,draw:.2,away:.1}}}}};
  const html=renderResultCard(invalid);

  assert.match(html,/Brier score: unavailable for missing or invalid probabilities/);
  assert.equal(resultsCompetitionNotice({active:false}),
    'The competition has not started. Historical statistics are shown below.');
  assert.equal(resultsCompetitionNotice({active:true}),'');
});
