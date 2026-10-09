import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionsRequest,parseDecision,predictDecision} from '../lib/decisions.mjs';
import {predictionEvidence,predictionQuestions} from '../lib/football.mjs';
import {forecastPanel} from '../forecast-view.mjs';

const match={id:55,home:{name:'Home',short:'HOM'},away:{name:'Away',short:'AWY'}};
const response=()=>({model:'gpt-6-luna',answers:Object.entries(predictionQuestions()).map(([name,q])=>({name,type:'choice',choice:name==='outcome'?'away':'1_0',probabilities:Object.keys(q.criteria).map(value=>({value,probability:value===(name==='outcome'?'away':'1_0')?1:0}))}))});

test('Decisions sends equivalent evidence and all outcome and zero-to-six score choices',()=>{
  const request=decisionsRequest(match);
  assert.deepEqual(JSON.parse(request.input),predictionEvidence(match));
  assert.equal(request.model,'gpt-6-luna');
  assert.equal(request.questions[0].choices.length,3);
  assert.equal(request.questions[1].choices.length,49);
  for(const question of request.questions) {
    assert.equal(question.instructions,predictionQuestions()[question.name].instructions);
    assert.deepEqual(Object.fromEntries(question.choices.map(c=>[c.value,c.description])),predictionQuestions()[question.name].criteria);
  }
});
test('valid named answers preserve independent score and outcome and actual model',()=>{
  const body=response();body.answers.reverse();body.model='gpt-6-luna-test-snapshot';
  const p=parseDecision(body);
  assert.equal(p.outcome,'away');assert.deepEqual(p.score,[1,0]);
  assert.deepEqual(p.probabilities,{home:0,draw:0,away:1});
  assert.equal(p.model,body.model);assert.ok(Number.isFinite(Date.parse(p.generatedAt)));
});
test('refused, missing, duplicate and invalid Decisions answers are never forecasts',()=>{
  for(const change of [
    b=>b.answers[0].type='refusal',b=>b.answers.pop(),b=>b.answers[1].name='outcome',
    b=>b.answers[0].probabilities[0].probability=-1,b=>b.answers[0].probabilities[0].probability=NaN,
    b=>b.answers[0].probabilities[0].probability=1,b=>b.answers[1].choice='7_0',
    b=>b.answers[1].probabilities.pop(),b=>b.answers[0].probabilities[1].value='home',b=>delete b.model,
  ]) {const b=response();change(b);assert.throws(()=>parseDecision(b));}
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
test('forecast panels expose separate outcomes, scores, timestamps and missing opinions safely',()=>{
  const p={...parseDecision(response()),generatedAt:'2026-10-09T09:00:00Z',model:'<script>bad</script>',stale:true};
  const html=forecastPanel(match,'openai',p);
  assert.match(html,/OpenAI Decisions/);assert.match(html,/Away win/);assert.match(html,/1 : 0/);
  assert.match(html,/2026-10-09T09:00:00Z/);assert.match(html,/earlier fixture information/);
  assert.ok(!html.includes('<script>'));assert.match(forecastPanel(match,'jev',null),/No prediction available/);
});
