import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionsRequest,parseDecision,predictDecision} from '../lib/decisions.mjs';
import {predictionEvidence,predictionQuestions} from '../lib/football.mjs';
import {scoreDistribution} from './support/score-distribution.mjs';
import {forecastAvailability,forecastPanel,forecastNotice} from '../forecast-view.mjs';

const match={id:55,home:{name:'Home',short:'HOM'},away:{name:'Away',short:'AWY'}};
const response=(weights={'0_1':1},choice='0_1')=>({model:'gpt-6-luna',answers:[{name:'score',type:'choice',choice,
  probabilities:Object.entries(scoreDistribution(weights)).map(([value,probability])=>({value,probability}))}]});

test('Decisions sends equivalent evidence and a single score choice question',()=>{
  const request=decisionsRequest(match);
  assert.deepEqual(JSON.parse(request.input),predictionEvidence(match));
  assert.equal(request.model,'gpt-6-luna');assert.equal(request.questions.length,1);
  const question=request.questions[0];
  assert.equal(question.name,'score');assert.equal(question.type,'choice');assert.equal(question.choices.length,49);
  assert.equal(question.instructions,predictionQuestions().score.instructions);
  assert.deepEqual(Object.fromEntries(question.choices.map(c=>[c.value,c.description])),predictionQuestions().score.criteria);
});
test('a single score answer derives consistent forecasts and preserves the actual model',()=>{
  const body=response();body.model='gpt-6-luna-test-snapshot';body.answers[0].probabilities.reverse();
  const p=parseDecision(body);
  assert.equal(p.outcome,'away');assert.deepEqual(p.score,[0,1]);
  assert.deepEqual(p.probabilities,{home:0,draw:0,away:1});
  assert.equal(p.model,body.model);assert.ok(Number.isFinite(Date.parse(p.generatedAt)));
  assert.equal(p.method,'score-distribution-result-first-v1');assert.equal(Object.keys(p.scoreProbabilities).length,49);
});
test('refused, missing, duplicate, unknown and invalid Decisions answers are never forecasts',()=>{
  for(const change of [
    b=>b.answers[0].type='refusal',b=>b.answers.pop(),b=>b.answers.push(structuredClone(b.answers[0])),
    b=>b.answers[0].name='outcome',b=>b.answers[0].probabilities[0].probability=-1,
    b=>b.answers[0].probabilities[0].probability=NaN,b=>b.answers[0].probabilities[0].probability=1,
    b=>b.answers[0].choice='7_0',b=>b.answers[0].probabilities.pop(),
    b=>b.answers[0].probabilities[1].value='0_0',b=>b.answers[0].probabilities[0].value='7_0',b=>delete b.model,
    b=>b.answers[0]=null,b=>b.answers[0].probabilities[0]=null,
  ]){const body=response();change(body);assert.throws(()=>parseDecision(body));}
});
test('HTTP access failure rejects the adapter without creating a forecast',async()=>{
  const original=globalThis.fetch, key=process.env.OPENAI_API_KEY;
  try{
    process.env.OPENAI_API_KEY='test-only-key';
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'https://api.openai.com/v1/decisions');assert.equal(options.headers.Authorization,'Bearer test-only-key');
      assert.deepEqual(JSON.parse(options.body),decisionsRequest(match));
      return new Response(JSON.stringify({error:{message:'Access denied'}}),{status:403});
    };
    await assert.rejects(predictDecision(match),/403/);
  }finally{globalThis.fetch=original;if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;}
});
test('a rate limit is one provider attempt and does not retry inside the adapter',async()=>{
  const original=globalThis.fetch,key=process.env.OPENAI_API_KEY;
  let calls=0;
  try {
    process.env.OPENAI_API_KEY='test-only-key';
    globalThis.fetch=async()=>{calls++;if(calls>1)throw new Error('A hidden retry occurred');return new Response('{}',{status:429});};
    await assert.rejects(predictDecision(match),/429/);
    assert.equal(calls,1);
  } finally {globalThis.fetch=original;if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;}
});
test('forecast panels expose forecasts without model names or missing placeholders',()=>{
  const p={...parseDecision(response()),generatedAt:'2026-10-09T09:00:00Z',model:'<script>bad</script>',stale:true};
  const html=forecastPanel(match,'openai',p);
  assert.match(html,/OpenAI/);assert.doesNotMatch(html,/OpenAI Decisions/);assert.match(html,/Away win/);assert.match(html,/0 : 1/);
  assert.match(html,/2026-10-09T09:00:00Z/);assert.match(html,/earlier fixture information/);
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('gpt-6-luna'));assert.equal(forecastPanel(match,'jev',null), '');
  assert.equal(forecastPanel(match,'openai',p,{status:'started',availability:'fresh'}).includes('Refresh in progress'),false);
  assert.equal(forecastPanel(match,'openai',p,{status:'succeeded',availability:'fresh'}).includes('Latest refresh succeeded'),false);
  assert.equal(forecastPanel(match,'openai',null,{status:'failed',availability:'missing'}),'');
  assert.match(forecastPanel(match,'openai',p,{status:'failed',availability:'retained'}),/Refresh failed.*Retaining the earlier forecast/);
});

test('forecast notice only claims automatic updates for enabled providers',()=>{
  const none=forecastNotice({jev:false,openai:false});
  assert.equal(none.error,true);assert.ok(!none.text.includes('automatically'));
  assert.match(forecastNotice({jev:true,openai:false}).text,/Jev forecasts/);
  assert.match(forecastNotice({jev:true,openai:false}).text,/OpenAI is currently unavailable/);
  assert.match(forecastNotice({jev:false,openai:true}).text,/OpenAI forecasts/);
  assert.match(forecastNotice({jev:false,openai:true}).text,/Jev is currently unavailable/);
  assert.match(forecastNotice({jev:true,openai:true}).text,/Jev and OpenAI forecasts/);
  assert.match(forecastNotice({jev:true,openai:true}).text,/next ten days/);
  assert.match(forecastNotice({jev:true,openai:true}).text,/Wednesday.*09:00.*09:59.*London/);
  assert.ok(!forecastNotice({jev:true,openai:true}).text.includes('each day'));
});

test('a matching old forecast and attempt are retained when the expected weekly run changes',()=>{
  const previous={runId:'run-previous',runKey:'weekly:2026-09-30T08:00:00.000Z'};
  const attempt={runId:'run-previous',runKey:previous.runKey};
  assert.equal(forecastAvailability(previous,attempt,'weekly:2026-10-07T08:00:00.000Z'),'retained');
  assert.equal(forecastAvailability({...previous,runId:'run-current',runKey:'weekly:2026-10-07T08:00:00.000Z'},attempt,'weekly:2026-10-07T08:00:00.000Z'),'retained');
  assert.equal(forecastAvailability({...previous,runKey:'weekly:2026-10-07T08:00:00.000Z'}, {...attempt,runId:'new-run'},'weekly:2026-10-07T08:00:00.000Z'),'retained');
});


test('OpenAI prioritizes aggregate results over its most likely individual score',()=>{
  const prediction=parseDecision(response({'1_1':.30,'2_1':.26,'1_0':.24,'0_1':.20},'1_1'));
  assert.equal(prediction.outcome,'home');assert.deepEqual(prediction.score,[2,1]);
  assert.equal(prediction.providerScoreChoice,'1_1');
});


test('OpenAI makes one score-only HTTP request and derives the forecast from returned probabilities',async()=>{
  const original=globalThis.fetch,key=process.env.OPENAI_API_KEY;
  let calls=0;
  try{
    process.env.OPENAI_API_KEY='test-only-key';
    globalThis.fetch=async(url,options)=>{
      calls++;assert.equal(url,'https://api.openai.com/v1/decisions');
      const request=JSON.parse(options.body);
      assert.deepEqual(request,decisionsRequest(match));assert.equal(request.questions.length,1);
      return new Response(JSON.stringify(response({'1_1':.30,'2_1':.26,'1_0':.24,'0_1':.20},'1_1')));
    };
    const prediction=await predictDecision(match);
    assert.equal(calls,1);assert.equal(prediction.outcome,'home');assert.deepEqual(prediction.score,[2,1]);
    assert.equal(prediction.model,'gpt-6-luna');assert.equal(prediction.method,'score-distribution-result-first-v1');
  }finally{globalThis.fetch=original;if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;}
});
