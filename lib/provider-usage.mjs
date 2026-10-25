const count=value=>Number.isSafeInteger(value) && value>=0 ? value : null;

// USD per million tokens, standard direct API rates checked 2026-10-25.
// Never claim that an estimate is the provider's billed charge.
const pricedModels={openai:'gpt-6-luna',claude:'claude-opus-5-5',chatgpt:'gpt-6.1-sol',gemini:'gemini-3.1-pro-preview'};
const rates={openai:{input:.10,output:0,cached:.01},claude:{input:4,output:20,cached:.20},chatgpt:{input:2,output:10,cached:.10},
  gemini:{input:2,output:12,cached:.20,longInput:4,longOutput:18,longCached:.40,longPromptThreshold:200000}};

export function providerMetadata(provider,body) {
  const raw=body?.usage;
  const usage=provider==='gemini' ? {
    inputTokens:count(body?.usageMetadata?.promptTokenCount),
    outputTokens:count(body?.usageMetadata?.candidatesTokenCount),
    reasoningTokens:count(body?.usageMetadata?.thoughtsTokenCount),
    cachedInputTokens:count(body?.usageMetadata?.cachedContentTokenCount),
  } : {inputTokens:count(raw?.input_tokens),outputTokens:count(raw?.output_tokens),
    reasoningTokens:count(raw?.output_tokens_details?.reasoning_tokens),
    cachedInputTokens:count(provider==='claude' ? raw?.cache_read_input_tokens : raw?.input_tokens_details?.cached_tokens),
    cacheWriteTokens:count(provider==='claude' ? raw?.cache_creation_input_tokens : raw?.input_tokens_details?.cache_write_tokens)};
  const model=provider==='gemini' ? body?.modelVersion : body?.model;
  let cost=null;
  const tariff=rates[provider];
  if(tariff && typeof model==='string' && (model===pricedModels[provider] || model.startsWith(pricedModels[provider]+'-'))
    && !(['chatgpt','openai'].includes(provider) && usage.inputTokens>100000) && usage.inputTokens!==null && usage.outputTokens!==null
    && !(usage.cacheWriteTokens>0)) {
    const cached=usage.cachedInputTokens??0;
    const input=provider==='claude' ? usage.inputTokens : usage.inputTokens-cached;
    const output=usage.outputTokens+(provider==='gemini' ? usage.reasoningTokens??0 : 0);
    const promptTokens=usage.inputTokens;
    const longPrompt=provider==='gemini' && promptTokens>tariff.longPromptThreshold;
    const inputRate=longPrompt ? tariff.longInput : tariff.input;
    const outputRate=longPrompt ? tariff.longOutput : tariff.output;
    const cachedRate=longPrompt ? tariff.longCached : tariff.cached;
    if(input>=0) cost={currency:'USD',amount:(input*inputRate+cached*cachedRate+output*outputRate)/1e6,
      estimated:true,ratesAsOf:'2026-10-25'};
  }
  return {model,usage,cost};
}

export function rejectedResponse(metadata) {
  return Object.assign(new Error('Provider refused or did not complete its forecast.'),{predictionMetadata:metadata});
}
