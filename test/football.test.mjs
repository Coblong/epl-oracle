import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFixtures, parsePrediction, predictionQuestions, teamRef, matchOutcome, evaluatePrediction, accuracySummary, validateTeamCatalog} from '../lib/football.mjs';
import {scoreAnswer} from './support/score-distribution.mjs';
const teams=[{id:1,name:'Home',short_name:'HOM',code:1},{id:2,name:'Away',short_name:'AWY',code:2}];
const match={id:1,team_h:1,team_a:2,event:1,kickoff_time:'2026-09-01T12:00:00Z',finished:true,started:true,team_h_score:2,team_a_score:1};
test('includes all future and undated fixtures but excludes started, finished and past matches',()=>{const rows=[match,{...match,id:2,finished:false,started:false,kickoff_time:'2026-10-01T12:00:00Z'},{...match,id:3,finished:false,started:false,kickoff_time:null},{...match,id:4,finished:false,started:true,kickoff_time:'2026-10-02T12:00:00Z'},{...match,id:5,finished:false,started:false}];const result=buildFixtures(rows,teams,Date.parse('2026-09-26'));assert.deepEqual(result.map(x=>x.id),[2,3]);assert.equal(result[0].home.points,3);assert.equal(result[0].away.goalsAgainst,2);assert.equal(result[0].away.recent[0].result,'L');});
test('provisional results contribute to form but elapsed matches without a finish flag do not',()=>{
  const provisional={...match,id:20,kickoff_time:'2026-09-25T12:00:00Z',finished:false,finished_provisional:true,started:true,team_h_score:2,team_a_score:1};
  const elapsed={...match,id:21,kickoff_time:'2026-09-25T12:00:00Z',finished:false,finished_provisional:false,started:true,minutes:90,team_h_score:4,team_a_score:0};
  const upcoming={...match,id:22,kickoff_time:'2026-10-11T12:00:00Z',finished:false,finished_provisional:false,started:false};
  const result=buildFixtures([provisional,elapsed,upcoming],teams,Date.parse('2026-10-10T20:00:00Z'));
  assert.deepEqual(result.map(f=>f.id),[22]);
  assert.equal(result[0].home.played,1);
  assert.equal(result[0].home.goalsFor,2);
});
test('team catalog validation rejects duplicates, incomplete identities and unknown fixture teams',()=>{
  const catalog=[{id:1,name:'Home',short_name:'HOM',code:1},{id:2,name:'Away',short_name:'AWY',code:2}];
  assert.deepEqual(validateTeamCatalog(catalog,[{id:10,team_h:1,team_a:2}]),catalog);
  assert.throws(()=>validateTeamCatalog([...catalog,catalog[0]],[{team_h:1,team_a:2}]),/Invalid Premier League team catalog/);
  assert.throws(()=>validateTeamCatalog([{...catalog[0],short_name:''},catalog[1]],[{team_h:1,team_a:2}]),/Invalid Premier League team catalog/);
  assert.throws(()=>validateTeamCatalog(catalog,[{id:11,team_h:1,team_a:3}]),/references an unknown team/);
});
test('an explicitly cancelled fixture is excluded while a missing status remains eligible for display',()=>{const result=buildFixtures([{...match,id:2,finished:false,started:false,kickoff_time:null},{...match,id:3,finished:false,started:false,cancelled:true}],teams,Date.parse('2026-09-26'));assert.deepEqual(result.map(x=>x.id),[2]);assert.equal(result[0].fixtureStatus,'awaiting_date');});
test('never uses future completed results as prediction evidence',()=>{const result=buildFixtures([{...match,kickoff_time:'2027-01-01'}, {...match,id:2,finished:false,started:false,kickoff_time:'2026-10-01'}],teams,Date.parse('2026-09-26'));assert.equal(result[0].home.played,0);});
test('validates complete score distributions before displaying model predictions',()=>{
  assert.deepEqual(parsePrediction(scoreAnswer()).score,[2,1]);
  for(const change of [b=>delete b.answers.score.probabilities['6_6'],b=>b.answers.score.choice='9_9',
    b=>b.answers.score.probabilities['2_1']=.5,b=>b.answers.score.type='refusal',b=>b.answers.outcome={choice:'home'}]){
    const body=scoreAnswer();change(body);assert.throws(()=>parsePrediction(body));
  }
  assert.throws(()=>parsePrediction({}));
});
test('requests only one score choice question with all 49 zero-to-six scorelines',()=>{
  const questions=predictionQuestions();
  assert.deepEqual(Object.keys(questions),['score']);
  assert.equal(questions.score.type,'choice');
  assert.equal(Object.keys(questions.score.criteria).length,49);
  assert.ok(questions.score.criteria['0_0']);assert.ok(questions.score.criteria['6_6']);
});
test('teamRef looks up club identity by id and falls back for unknown ids',()=>{assert.deepEqual(teamRef(teams,1),{id:1,name:'Home',short:'HOM',code:1});assert.equal(teamRef(teams,99).name,'Unknown');});
test('matchOutcome derives home, draw or away from the final score',()=>{assert.equal(matchOutcome(2,1),'home');assert.equal(matchOutcome(1,2),'away');assert.equal(matchOutcome(1,1),'draw');});
test('evaluatePrediction scores outcome and exact-score accuracy independently',()=>{const prediction={outcome:'home',score:[2,1]};assert.deepEqual(evaluatePrediction(prediction,2,1),{actualScore:[2,1],actualOutcome:'home',correctOutcome:true,correctScore:true});assert.deepEqual(evaluatePrediction(prediction,3,1),{actualScore:[3,1],actualOutcome:'home',correctOutcome:true,correctScore:false});assert.equal(evaluatePrediction(prediction,1,2).correctOutcome,false);});
test('accuracySummary tallies a running total across resolved results',()=>{const results=[{correctOutcome:true,correctScore:true},{correctOutcome:true,correctScore:false},{correctOutcome:false,correctScore:false}];assert.deepEqual(accuracySummary(results),{resolved:3,outcomeCorrect:2,outcomeAccuracy:2/3,scoreCorrect:1,scoreAccuracy:1/3});assert.deepEqual(accuracySummary([]),{resolved:0,outcomeCorrect:0,outcomeAccuracy:null,scoreCorrect:0,scoreAccuracy:null});});
test('accuracySummary excludes cancelled and ineligible legacy result rows',()=>{assert.deepEqual(accuracySummary([{correctOutcome:true,correctScore:true},{correctOutcome:true,correctScore:true,cancelled:true},{correctOutcome:false,correctScore:false,eligible:false}]),{resolved:1,outcomeCorrect:1,outcomeAccuracy:1,scoreCorrect:1,scoreAccuracy:1});});
