import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveScorePrediction,matchOutcome,parsePrediction} from '../lib/football.mjs';
import {scoreDistribution,scoreAnswer} from './support/score-distribution.mjs';
const near = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-12,`${actual} != ${expected}`);

test('aggregate result takes priority over the provider global score choice',()=>{
  const prediction=parsePrediction(scoreAnswer({'1_1':.30,'2_1':.26,'1_0':.24,'0_1':.20},'1_1'));
  assert.equal(prediction.outcome,'home');
  assert.deepEqual(prediction.score,[2,1]);
  near(prediction.probabilities.home,.50);
  near(prediction.probabilities.draw,.30);
  near(prediction.probabilities.away,.20);
  assert.equal(prediction.providerScoreChoice,'1_1');
  assert.equal(prediction.method,'score-distribution-result-first-v1');
  assert.equal(Object.keys(prediction.scoreProbabilities).length,49);
});

test('away wins and draws use the same aggregate result-first rule',()=>{
  const away=deriveScorePrediction(scoreDistribution({'1_1':.30,'1_2':.26,'0_1':.24,'1_0':.20}));
  assert.equal(away.outcome,'away');assert.deepEqual(away.score,[1,2]);
  const draw=deriveScorePrediction(scoreDistribution({'0_1':.49,'1_1':.26,'0_0':.25}));
  assert.equal(draw.outcome,'draw');assert.deepEqual(draw.score,[1,1]);
});

test('normalizes accepted rounding differences and retains the original total without modifying inputs',()=>{
  const distribution=scoreDistribution({'1_1':.30,'2_1':.26,'1_0':.24,'0_1':.19});
  const original=structuredClone(distribution);
  const prediction=deriveScorePrediction(distribution);
  near(prediction.scoreProbabilityTotal,.99);
  near(prediction.scoreProbabilities['2_1'],.26/.99);
  near(Object.values(prediction.probabilities).reduce((sum,p)=>sum+p,0),1);
  near(Object.values(prediction.scoreProbabilities).reduce((sum,p)=>sum+p,0),1);
  assert.deepEqual(distribution,original);
});

test('rejects missing, unknown, negative, nonfinite, nonnumeric and invalid-total score probabilities',()=>{
  for(const change of [
    p=>delete p['6_6'],p=>p['7_0']=0,p=>p['0_0']=-.1,p=>p['0_0']=Infinity,
    p=>p['0_0']=NaN,p=>p['0_0']='0',p=>p['2_1']=1.01,p=>p['2_1']=.5,p=>p['2_1']=0,
    p=>{delete p['6_6'];p['7_0']=0;},
  ]){
    const distribution=scoreDistribution();change(distribution);
    assert.throws(()=>deriveScorePrediction(distribution),/invalid|incomplete/);
  }
  for(const input of [null,[],{},'1'])assert.throws(()=>deriveScorePrediction(input));
});

test('ties use individual score probability, then fewer goals, then stable home/draw/away order',()=>{
  const stronger=deriveScorePrediction(scoreDistribution({'1_0':.4,'2_0':.1,'0_1':.3,'0_2':.2}));
  assert.equal(stronger.outcome,'home');assert.deepEqual(stronger.score,[1,0]);
  const fewer=deriveScorePrediction(scoreDistribution({'2_1':.5,'0_1':.5}));
  assert.equal(fewer.outcome,'away');assert.deepEqual(fewer.score,[0,1]);
  const uniform=scoreDistribution(Object.fromEntries(Object.keys(scoreDistribution()).map(key=>[key,1/49])));
  const first=deriveScorePrediction(uniform);
  assert.equal(first.outcome,'home');assert.deepEqual(first.score,[1,0]);
  assert.deepEqual(deriveScorePrediction(Object.fromEntries(Object.entries(uniform).reverse())),first);
});

test('score ties within the chosen result prefer fewer goals then lower home goals',()=>{
  const fewer=deriveScorePrediction(scoreDistribution({'2_0':.4,'2_1':.4,'0_0':.2}));
  assert.deepEqual(fewer.score,[2,0]);
  const lowerHome=deriveScorePrediction(scoreDistribution({'3_0':.4,'2_1':.4,'1_1':.2}));
  assert.deepEqual(lowerHome.score,[2,1]);
});

test('all single-score distributions derive their matching result including grid boundaries',()=>{
  for(let home=0;home<=6;home++)for(let away=0;away<=6;away++){
    const prediction=deriveScorePrediction(scoreDistribution({[`${home}_${away}`]:1}));
    assert.deepEqual(prediction.score,[home,away]);
    assert.equal(prediction.outcome,matchOutcome(home,away));
    assert.equal(prediction.probabilities[prediction.outcome],1);
  }
});
