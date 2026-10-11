import test from 'node:test';
import assert from 'node:assert/strict';
import {predictMatch} from '../lib/jev.mjs';
import {predictionEvidence,predictionQuestions} from '../lib/football.mjs';
import {scoreAnswer} from './support/score-distribution.mjs';

const match={id:55,home:{name:'Home',short:'HOM'},away:{name:'Away',short:'AWY'}};

test('Jev sends one score question and derives a result-first forecast in a single HTTP attempt',async()=>{
  const original=globalThis.fetch,key=process.env.AI_GATEWAY_API_KEY;
  let calls=0;
  try{
    process.env.AI_GATEWAY_API_KEY='test-only-key';
    globalThis.fetch=async(url,options)=>{
      calls++;
      assert.equal(url,'https://ai-gateway.vercel.sh/v1/evaluate');assert.equal(options.method,'POST');
      assert.equal(options.headers.Authorization,'Bearer test-only-key');
      const body=JSON.parse(options.body);
      assert.equal(body.model,'typesafe-ai/jev');assert.deepEqual(body.state,predictionEvidence(match));
      assert.deepEqual(body.questions,predictionQuestions());assert.deepEqual(Object.keys(body.questions),['score']);
      return new Response(JSON.stringify(scoreAnswer({'1_1':.30,'2_1':.26,'1_0':.24,'0_1':.20},'1_1')));
    };
    const prediction=await predictMatch(match);
    assert.equal(calls,1);assert.equal(prediction.outcome,'home');assert.deepEqual(prediction.score,[2,1]);
    assert.equal(prediction.model,'typesafe-ai/jev');assert.equal(prediction.providerScoreChoice,'1_1');
    assert.equal(prediction.method,'score-distribution-result-first-v1');
  }finally{globalThis.fetch=original;if(key===undefined)delete process.env.AI_GATEWAY_API_KEY;else process.env.AI_GATEWAY_API_KEY=key;}
});

test('Jev rejects incomplete score evidence without an internal retry',async()=>{
  const original=globalThis.fetch,key=process.env.AI_GATEWAY_API_KEY;
  let calls=0;
  try{
    process.env.AI_GATEWAY_API_KEY='test-only-key';
    globalThis.fetch=async()=>{calls++;const body=scoreAnswer();delete body.answers.score.probabilities['6_6'];return new Response(JSON.stringify(body));};
    await assert.rejects(predictMatch(match),/incomplete or invalid/);assert.equal(calls,1);
  }finally{globalThis.fetch=original;if(key===undefined)delete process.env.AI_GATEWAY_API_KEY;else process.env.AI_GATEWAY_API_KEY=key;}
});
