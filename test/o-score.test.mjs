import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scoreMatchOScore,summarizeOScoreMatches,summarizeSharedOScoreMatches} from '../lib/o-score.mjs';

const agents=['exact','one-off','short','draw','away','missing-a','missing-b'];

test('O Score uses both goal errors and a one-point result penalty',()=>{
  const scores=scoreMatchOScore({
    exact:{outcome:'home',score:[5,0]},
    'one-off':{outcome:'home',score:[4,0]},
    short:{outcome:'home',score:[1,0]},
    draw:{outcome:'draw',score:[2,2]},
    away:{outcome:'away',score:[0,5]},
  },[5,0],agents);

  assert.deepEqual(scores.exact,{value:0,source:'earned',homeGoalError:0,awayGoalError:0,resultPenalty:0});
  assert.deepEqual(scores['one-off'],{value:1,source:'earned',homeGoalError:1,awayGoalError:0,resultPenalty:0});
  assert.deepEqual(scores.short,{value:4,source:'earned',homeGoalError:4,awayGoalError:0,resultPenalty:0});
  assert.deepEqual(scores.draw,{value:6,source:'earned',homeGoalError:3,awayGoalError:2,resultPenalty:1});
  assert.deepEqual(scores.away,{value:11,source:'earned',homeGoalError:5,awayGoalError:5,resultPenalty:1});
});

test('missing agents share the exact mean of earned scores without invented breakdowns',()=>{
  const scores=scoreMatchOScore({
    exact:{outcome:'home',score:[5,0]},
    'one-off':{outcome:'home',score:[4,0]},
  },[5,0],agents);

  assert.deepEqual(scores['missing-a'],{value:0.5,source:'mean_assigned',homeGoalError:null,awayGoalError:null,resultPenalty:null});
  assert.deepEqual(scores['missing-b'],scores['missing-a']);
});

test('all missing forecasts and cancelled or invalid results receive no O Score',()=>{
  const forecast={exact:{outcome:'home',score:[5,0]}};
  for(const actualScore of [null,[5,null],[-1,0]]){
    const scores=scoreMatchOScore(forecast,actualScore,agents);
    for(const score of Object.values(scores)) assert.deepEqual(score,
      {value:null,source:'unavailable',homeGoalError:null,awayGoalError:null,resultPenalty:null});
  }
  const allMissing=scoreMatchOScore({},[5,0],agents);
  for(const score of Object.values(allMissing)) assert.equal(score.source,'unavailable');
});

test('O Score diagnostics keep earned, mean-assigned and unavailable counts separate',()=>{
  const summary=summarizeOScoreMatches([
    {actualScore:[5,0],forecasts:{exact:{outcome:'home',score:[5,0]},'one-off':{outcome:'home',score:[4,0]}}},
    {actualScore:[0,0],forecasts:{exact:{outcome:'home',score:[1,0]}}},
    {actualScore:[2,1],forecasts:{}},
    {status:'cancelled',actualScore:[2,1],forecasts:{exact:{outcome:'home',score:[2,1]}}},
  ],['exact','one-off','missing-a']);

  assert.deepEqual(summary.exact,{eligibleMatchCount:3,submittedCount:2,missingCount:1,earnedCount:2,meanAssignedCount:0,unavailableCount:1,sampleCount:2,total:2,average:1});
  assert.deepEqual(summary['one-off'],{eligibleMatchCount:3,submittedCount:1,missingCount:2,earnedCount:1,meanAssignedCount:1,unavailableCount:1,sampleCount:2,total:3,average:1.5});
  assert.deepEqual(summary['missing-a'],{eligibleMatchCount:3,submittedCount:0,missingCount:3,earnedCount:0,meanAssignedCount:2,unavailableCount:1,sampleCount:2,total:2.5,average:1.25});
});

test('shared O Score diagnostics use only completed matches with every agent forecast',()=>{
  const scored={
    exact:{outcome:'home',score:[2,1]},one:{outcome:'home',score:[3,1]},
    short:{outcome:'draw',score:[2,2]},away:{outcome:'home',score:[1,0]},
    missingA:{outcome:'away',score:[0,3]},
  };
  const result=summarizeSharedOScoreMatches([
    {status:'completed',actualScore:[2,1],forecasts:scored},
    {status:'completed',actualScore:[0,0],forecasts:{...scored,missingA:undefined}},
    {status:'cancelled',actualScore:null,forecasts:scored},
  ],['exact','one','short','away','missingA']);
  assert.equal(result.scope,'shared_all_agents');
  assert.equal(result.resolved,1);
  assert.equal(result.providerSummaries.exact.total,0);
  assert.equal(result.providerSummaries.exact.sampleCount,1);
  assert.equal(result.providerSummaries.exact.submittedCount,1);
  assert.equal(result.providerSummaries.exact.missingCount,0);
  assert.equal(result.providerSummaries.missingA.total,5);
  assert.equal(result.providerSummaries.missingA.meanAssignedCount,0);
});
