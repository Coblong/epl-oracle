import {providerMetadata} from './provider-usage.mjs';
import {jsonFetch} from './http.mjs';
import {predictionEvidence, predictionQuestions, parsePrediction} from './football.mjs';

export async function predictMatch(match) {
  if (!process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY is not configured.');
  const body = await jsonFetch('https://ai-gateway.vercel.sh/v1/evaluate', {
    method: 'POST',
    headers: {Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: 'typesafe-ai/jev',
      state: predictionEvidence(match),
      questions: predictionQuestions(),
    }),
  }, {attempts:1});
  const metadata=providerMetadata('jev',body);
  metadata.model=typeof body?.model==='string' && body.model.trim() ? body.model : 'typesafe-ai/jev';
  metadata.modelSource=body?.model ? 'response' : 'requested';
  try {return {...parsePrediction(body),...metadata};}
  catch(error) {throw Object.assign(error,{predictionMetadata:metadata});}
}
