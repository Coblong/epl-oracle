import test from 'node:test';
import assert from 'node:assert/strict';
import {predictClaude} from '../lib/claude.mjs';
import {predictionEvidence} from '../lib/football.mjs';
import {scoreDistribution} from './support/score-distribution.mjs';

const match={id:55,home:{name:'Home'},away:{name:'Away'}};
const distribution=()=>scoreDistribution({'1_1':.30,'2_1':.26,'1_0':.24,'0_1':.20});

test('Claude sends saved evidence once and retains the actual model, usage and result-first forecast',async t=>{
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://api.anthropic.com/v1/messages');
    assert.equal(options.headers['x-api-key'],'test-only-key');
    const body=JSON.parse(options.body);
    assert.equal(body.model,'claude-opus-5-5');
    assert.deepEqual(JSON.parse(body.messages[0].content).evidence,predictionEvidence(match));
    assert.equal(body.max_tokens,4096);
    assert.equal(body.output_config.effort,'low');
    assert.equal(body.output_config.format.schema.properties.scoreProbabilities.required.length,49);
    assert.ok(Object.values(body.output_config.format.schema.properties.scoreProbabilities.properties)
      .every(property=>property.type==='number'&&!Object.hasOwn(property,'minimum')&&!Object.hasOwn(property,'maximum')));
    return Response.json({model:'claude-opus-5-5-20261001',stop_reason:'end_turn',
      content:[{type:'text',text:JSON.stringify({scoreProbabilities:distribution()})}],
      usage:{input_tokens:1000,output_tokens:200}});
  });
  const prediction=await predictClaude(match,{apiKey:'test-only-key'});
  assert.equal(prediction.outcome,'home');assert.deepEqual(prediction.score,[2,1]);
  assert.equal(prediction.model,'claude-opus-5-5-20261001');
  assert.equal(prediction.usage.inputTokens,1000);assert.equal(prediction.usage.outputTokens,200);
  assert.equal(prediction.cost.amount,.008);assert.equal(prediction.cost.estimated,true);
  assert.equal(prediction.method,'score-distribution-result-first-v1');
});

test('ChatGPT uses Responses with bounded low reasoning and retains billed output usage',async t=>{
  const {predictChatGPT}=await import('../lib/chatgpt.mjs');
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    const body=JSON.parse(options.body);
    assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.store,false);
    assert.equal(body.max_output_tokens,4096);assert.deepEqual(body.reasoning,{effort:'low'});
    assert.deepEqual(JSON.parse(body.input).evidence,predictionEvidence(match));
    assert.equal(body.text.format.strict,true);
    return Response.json({model:'gpt-6.1-sol-20261001',status:'completed',output:[{type:'reasoning'},
      {type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({scoreProbabilities:distribution()})}]}],
      usage:{input_tokens:1000,output_tokens:400,input_tokens_details:{cached_tokens:100},output_tokens_details:{reasoning_tokens:200}}});
  });
  const prediction=await predictChatGPT(match,{apiKey:'test-only-key'});
  assert.equal(prediction.outcome,'home');assert.deepEqual(prediction.score,[2,1]);
  assert.equal(prediction.model,'gpt-6.1-sol-20261001');
  assert.equal(prediction.usage.reasoningTokens,200);assert.equal(prediction.cost.amount,.00581);
});

test('Gemini keeps its key out of URLs and counts thinking separately in the cost estimate',async t=>{
  const {predictGemini}=await import('../lib/gemini.mjs');
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent');
    assert.equal(options.headers['x-goog-api-key'],'test-only-key');
    const body=JSON.parse(options.body);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text).evidence,predictionEvidence(match));
    assert.equal(body.generationConfig.maxOutputTokens,4096);
    assert.deepEqual(body.generationConfig.thinkingConfig,{thinkingLevel:'LOW'});
    assert.equal(body.generationConfig.responseJsonSchema.properties.scoreProbabilities.required.length,49);
    return Response.json({modelVersion:'gemini-3.1-pro-preview',candidates:[{finishReason:'STOP',content:{parts:[
      {thought:true,text:'private reasoning'}, {text:JSON.stringify({scoreProbabilities:distribution()})}]}}],
      usageMetadata:{promptTokenCount:1000,candidatesTokenCount:200,thoughtsTokenCount:100}});
  });
  const prediction=await predictGemini(match,{apiKey:'test-only-key'});
  assert.equal(prediction.outcome,'home');assert.deepEqual(prediction.score,[2,1]);
  assert.equal(prediction.model,'gemini-3.1-pro-preview');assert.equal(prediction.usage.reasoningTokens,100);
  assert.equal(prediction.cost.amount,.0056);
  assert.ok(!JSON.stringify(prediction).includes('private reasoning'));
});

test('Gemini normalizes a complete bounded distribution and preserves its original total',async t=>{
  const {predictGemini}=await import('../lib/gemini.mjs');
  const probabilities=scoreDistribution({'1_1':.20,'2_1':.30,'1_0':.24,'0_1':.20,'0_0':.097});
  t.mock.method(globalThis,'fetch',async()=>Response.json({modelVersion:'gemini-3.1-pro-preview',
    candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({scoreProbabilities:probabilities})}]}}],
    usageMetadata:{promptTokenCount:100, candidatesTokenCount:200}}));
  const prediction=await predictGemini(match,{apiKey:'test-only-key'});
  assert.equal(prediction.outcome,'home');assert.deepEqual(prediction.score,[2,1]);
  assert.ok(Math.abs(prediction.scoreProbabilityTotal-1.037)<1e-12);
  assert.equal(Object.keys(prediction.scoreProbabilities).length,49);
  assert.ok(Math.abs(Object.values(prediction.scoreProbabilities).reduce((sum,value)=>sum+value,0)-1)<1e-12);
});

const successfulBodies={
  claude:()=>({model:'claude-opus-5-5',stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({scoreProbabilities:distribution()})}],usage:{input_tokens:100,output_tokens:200}}),
  chatgpt:()=>({model:'gpt-6.1-sol',status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({scoreProbabilities:distribution()})}]}],usage:{input_tokens:100,output_tokens:200}}),
  gemini:()=>({modelVersion:'gemini-3.1-pro-preview',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({scoreProbabilities:distribution()})}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:200}}),
};
const adapterFor=async provider=>provider==='claude'?predictClaude:provider==='chatgpt'?(await import('../lib/chatgpt.mjs')).predictChatGPT:(await import('../lib/gemini.mjs')).predictGemini;
const replaceText=(provider,body,text)=>{
  if(provider==='claude') body.content[0].text=text;
  else if(provider==='chatgpt') body.output[0].content[0].text=text;
  else body.candidates[0].content.parts[0].text=text;
};

for(const provider of ['claude','chatgpt','gemini']) {
  test(`${provider} rejects malformed distributions, refusals, missing models and truncated output while retaining usage`,async t=>{
    const predict=await adapterFor(provider);
    let body;
    t.mock.method(globalThis,'fetch',async()=>Response.json(body));
    const invalid=[null,{}, {scoreProbabilities:{'1_0':1}}, {scoreProbabilities:{...distribution(),'7_0':0}},
      {scoreProbabilities:{...distribution(),'2_1':-1}}, {scoreProbabilities:{...distribution(),'2_1':1.01}},
      {scoreProbabilities:scoreDistribution({'1_0':0})},
      {scoreProbabilities:distribution(),explanation:'extra'}];
    if(provider!=='gemini') invalid.push({scoreProbabilities:scoreDistribution({'1_0':.5})});
    for(const value of invalid){
      body=successfulBodies[provider]();replaceText(provider,body,JSON.stringify(value));
      await assert.rejects(predict(match,{apiKey:'test-only-key'}),error=>error.predictionMetadata.usage.inputTokens===100);
    }
    body=successfulBodies[provider]();replaceText(provider,body,'not JSON');
    await assert.rejects(predict(match,{apiKey:'test-only-key'}));
    for(const reason of ['refusal','truncated']){
      body=successfulBodies[provider]();
      if(provider==='claude')body.stop_reason=reason==='refusal'?'refusal':'max_tokens';
      if(provider==='chatgpt')body.status=reason==='refusal'?'failed':'incomplete';
      if(provider==='gemini')body.candidates[0].finishReason=reason==='refusal'?'SAFETY':'MAX_TOKENS';
      await assert.rejects(predict(match,{apiKey:'test-only-key'}),error=>error.predictionMetadata.usage.inputTokens===100);
    }
    body=successfulBodies[provider]();delete body.model;delete body.modelVersion;
    await assert.rejects(predict(match,{apiKey:'test-only-key'}));
  });
  test(`${provider} makes no hidden HTTP retries and never calls upstream without a credential`,async t=>{
    const predict=await adapterFor(provider);
    let calls=0;
    t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('{}',{status:429});});
    await assert.rejects(predict(match,{apiKey:''}),/not configured/);assert.equal(calls,0);
    await assert.rejects(predict(match,{apiKey:'test-only-key'}),/429/);assert.equal(calls,1);
    t.mock.method(globalThis,'fetch',async()=>{throw new DOMException('Timed out','TimeoutError');});
    await assert.rejects(predict(match,{apiKey:'test-only-key'}),/Timed out/);
  });
}

test('cost estimates are absent for unknown models and absent usage, rather than invented charges',async t=>{
  let body=successfulBodies.claude();body.model='unpriced-model';
  t.mock.method(globalThis,'fetch',async()=>Response.json(body));
  assert.equal((await predictClaude(match,{apiKey:'test-only-key'})).cost,null);
  body=successfulBodies.claude();delete body.usage;
  assert.equal((await predictClaude(match,{apiKey:'test-only-key'})).cost,null);
});

test('Claude supports selecting a workspace for an unscoped API key',async t=>{
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(options.headers['anthropic-workspace-id'],'wrkspc_test');
    return Response.json(successfulBodies.claude());
  });
  await predictClaude(match,{apiKey:'test-only-key',workspaceId:'wrkspc_test'});
});

test('malformed provider envelopes still retain usage for the failed attempt',async t=>{
  let body;
  t.mock.method(globalThis,'fetch',async()=>Response.json(body));
  for(const provider of ['claude','chatgpt','gemini']){
    body=successfulBodies[provider]();
    if(provider==='claude')body.content={};
    if(provider==='chatgpt')body.output={};
    if(provider==='gemini')body.candidates[0].content.parts={};
    const predict=await adapterFor(provider);
    await assert.rejects(predict(match,{apiKey:'test-only-key'}),error=>error.predictionMetadata?.usage.inputTokens===100);
  }
});
