import {jsonFetch} from './http.mjs';
import {predictionQuestions, parsePrediction} from './football.mjs';

export async function predictMatch(match) {
  if (!process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY is not configured.');
  const body = await jsonFetch('https://ai-gateway.vercel.sh/v1/evaluate', {
    method: 'POST',
    headers: {Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: 'typesafe-ai/jev',
      state: {
        competition: 'English Premier League',
        match,
        context: 'Statistics are current-season completed league results only. No live injury, lineup or betting data is provided. Model probabilities are unvalidated football estimates.',
      },
      questions: predictionQuestions(),
    }),
  });
  return parsePrediction(body);
}
