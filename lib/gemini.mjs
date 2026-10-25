import {jsonFetch} from './http.mjs';
import {forecastPrompt,forecastSchema,parseStructuredForecast} from './structured-forecast.mjs';
import {providerMetadata,rejectedResponse} from './provider-usage.mjs';

function parseGeminiForecast(text,metadata) {
  let parsed;
  try { parsed=JSON.parse(text); } catch { return parseStructuredForecast(text,metadata); }
  const expected=forecastSchema().properties.scoreProbabilities.required;
  const probabilities=parsed?.scoreProbabilities;
  if(Object.keys(parsed??{}).length!==1 || !probabilities || typeof probabilities!=='object' || Array.isArray(probabilities)
    || Object.keys(probabilities).length!==expected.length || !expected.every(key=>Object.hasOwn(probabilities,key))) {
    return parseStructuredForecast(text,metadata);
  }
  const values=expected.map(key=>probabilities[key]);
  if(!values.every(value=>Number.isFinite(value) && value>=0 && value<=1)) return parseStructuredForecast(text,metadata);
  const originalTotal=values.reduce((sum,value)=>sum+value,0);
  if(!Number.isFinite(originalTotal) || originalTotal===0) return parseStructuredForecast(text,metadata);
  const normalized=Object.fromEntries(expected.map(key=>[key,probabilities[key]/originalTotal]));
  return parseStructuredForecast(JSON.stringify({scoreProbabilities:normalized}),{...metadata,scoreProbabilityTotal:originalTotal});
}

export async function predictGemini(match,{apiKey=process.env.GEMINI_API_KEY}={}) {
  if(!apiKey) throw new Error('GEMINI_API_KEY is not configured.');
  const body=await jsonFetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent',{
    method:'POST',headers:{'x-goog-api-key':apiKey,'Content-Type':'application/json'},
    body:JSON.stringify({contents:[{role:'user',parts:[{text:forecastPrompt(match)}]}],
      generationConfig:{candidateCount:1,maxOutputTokens:4096,thinkingConfig:{thinkingLevel:'MINIMAL'},
        responseMimeType:'application/json',responseJsonSchema:forecastSchema()}}),
  },{attempts:1});
  const metadata=providerMetadata('gemini',body);
  const candidate=body?.candidates?.[0];
  const parts=Array.isArray(candidate?.content?.parts) ? candidate.content.parts.filter(part=>part && !part.thought) : [];
  if(body?.promptFeedback?.blockReason || body?.candidates?.length!==1 || candidate?.finishReason!=='STOP'
    || parts?.length!==1 || typeof parts[0].text!=='string') throw rejectedResponse(metadata);
  return parseGeminiForecast(parts[0].text,metadata);
}
