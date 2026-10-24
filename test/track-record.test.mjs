import {test} from 'node:test';
import assert from 'node:assert/strict';
import {outcomeBrier,trackRecordSummaries} from '../lib/track-record.mjs';

const forecast = (probabilities={home:.6,draw:.25,away:.15}) => ({outcome:'home',score:[2,1],probabilities});
const row = (fixtureId,provider,prediction=forecast(),actualScore=[2,1]) => ({fixtureId,provider,prediction,actualScore});
const near = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-12,`${actual} != ${expected}`);

test('Brier uses the three-class sum and handles certainty at both extremes',()=>{
  near(outcomeBrier(forecast(),'home'),.245);
  assert.equal(outcomeBrier(forecast({home:1,draw:0,away:0}),'home'),0);
  assert.equal(outcomeBrier(forecast({home:1,draw:0,away:0}),'away'),2);
  near(outcomeBrier(forecast({home:1/3,draw:1/3,away:1/3}),'draw'),2/3);
});

test('small rounding differences are normalized without modifying persisted probabilities',()=>{
  const prediction=forecast({home:.6,draw:.25,away:.14});
  const original=structuredClone(prediction);
  const expected=(.6/.99-1)**2+(.25/.99)**2+(.14/.99)**2;
  near(outcomeBrier(prediction,'home'),expected);
  assert.deepEqual(prediction,original);
});

test('missing or invalid probabilities have no Brier score',()=>{
  for(const probabilities of [undefined,{}, {home:1,draw:0}, {home:NaN,draw:0,away:1},
    {home:Infinity,draw:0,away:0},{home:-.1,draw:.2,away:.9},{home:1.1,draw:0,away:0},
    {home:0,draw:0,away:0},{home:.2,draw:.2,away:.2}]){
    assert.equal(outcomeBrier({probabilities},'home'),null);
  }
});

test('provider-only fixtures count in full histories but not the shared comparison',()=>{
  const {providerSummaries:full,sharedComparison:shared}=trackRecordSummaries([
    row(1,'jev'),row(1,'openai',{...forecast(),outcome:'draw',score:[1,1]}),
    row(2,'jev'),row(3,'openai',forecast(),[0,1]),
  ],['jev','openai']);
  assert.equal(full.jev.resolved,2);
  assert.equal(full.jev.outcomeCorrect,2);
  assert.equal(full.openai.resolved,2);
  assert.equal(full.openai.outcomeCorrect,0);
  assert.equal(shared.resolved,1);
  assert.equal(shared.providerSummaries.jev.resolved,1);
  assert.equal(shared.providerSummaries.openai.resolved,1);
  near(shared.providerSummaries.jev.brierScore,.245);
  near(shared.providerSummaries.openai.brierScore,.245);
});

test('paired Brier excludes both providers when either has missing evidence but accuracy retains the match',()=>{
  const missing={...forecast(),probabilities:undefined};
  const {providerSummaries:full,sharedComparison:shared}=trackRecordSummaries([
    row(1,'jev'),row(1,'openai'),row(2,'jev'),row(2,'openai',missing),
  ],['jev','openai']);
  assert.equal(full.jev.brierSampleCount,2);
  assert.equal(full.openai.brierSampleCount,1);
  for(const provider of ['jev','openai']){
    assert.equal(shared.providerSummaries[provider].resolved,2);
    assert.equal(shared.providerSummaries[provider].outcomeCorrect,2);
    assert.equal(shared.providerSummaries[provider].brierSampleCount,1);
    near(shared.providerSummaries[provider].brierScore,.245);
  }
});

test('official score corrections change accuracy and Brier without changing forecast evidence',()=>{
  const prediction=forecast();
  const summary=trackRecordSummaries([row(1,'jev',prediction,[0,1])]).providerSummaries.jev;
  assert.equal(summary.outcomeCorrect,0);
  assert.equal(summary.scoreCorrect,0);
  near(summary.brierScore,1.145);
  assert.deepEqual(prediction,forecast());
});

test('empty histories have zero counts and no accuracy or Brier values',()=>{
  const {providerSummaries,sharedComparison}=trackRecordSummaries([]);
  assert.equal(sharedComparison.resolved,0);
  for(const summaries of [providerSummaries,sharedComparison.providerSummaries]) for(const provider of ['jev','openai']){
    assert.deepEqual(summaries[provider],{resolved:0,outcomeCorrect:0,outcomeAccuracy:null,
      scoreCorrect:0,scoreAccuracy:null,brierSampleCount:0,brierScore:null});
  }
});

test('the five-agent comparison has a common fixture and Brier denominator while retaining older pair histories',()=>{
  const ids=['jev','openai','claude','chatgpt','gemini'];
  const rows=[row(1,'jev'),row(1,'openai'),...ids.map(id=>row(2,id)),
    ...ids.map(id=>row(3,id,id==='gemini'?{...forecast(),probabilities:null}:forecast()))];
  const {providerSummaries,sharedComparison}=trackRecordSummaries(rows);
  assert.deepEqual(sharedComparison.providerIds,ids);
  assert.equal(providerSummaries.jev.resolved,3);assert.equal(providerSummaries.gemini.resolved,2);
  assert.equal(sharedComparison.resolved,2);
  for(const id of ids){
    assert.equal(sharedComparison.providerSummaries[id].resolved,2);
    assert.equal(sharedComparison.providerSummaries[id].brierSampleCount,1);
    near(sharedComparison.providerSummaries[id].brierScore,.245);
  }
  assert.equal(trackRecordSummaries(rows,['jev','openai']).sharedComparison.resolved,3);
});
