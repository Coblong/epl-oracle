import {jsonFetch} from './http.mjs';
import {forecastPrompt,forecastSchema,parseStructuredForecast} from './structured-forecast.mjs';
import {providerMetadata,rejectedResponse} from './provider-usage.mjs';

export async function predictGemini(match,{apiKey=process.env.GEMINI_API_KEY}={}) {
  if(!apiKey) throw new Error('GEMINI_API_KEY is not configured.');
  const body=await jsonFetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',{
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
  return parseStructuredForecast(parts[0].text,metadata);
}
