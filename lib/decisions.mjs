import {jsonFetch} from './http.mjs';
import {predictionEvidence, predictionQuestions, parsePrediction} from './football.mjs';

export function decisionsRequest(match) {
  return {model:'gpt-6-luna', input:JSON.stringify(predictionEvidence(match)),
    questions:Object.entries(predictionQuestions()).map(([name,q]) => ({name, type:'choice', instructions:q.instructions,
      choices:Object.entries(q.criteria).map(([value,description]) => ({value,description}))}))};
}

export function parseDecision(body) {
  if (typeof body?.model !== 'string' || !body.model || !Array.isArray(body.answers) || body.answers.length !== 2) throw new Error('Invalid Decisions response.');
  const answers = {};
  for (const answer of body.answers) {
    if (!['outcome','score'].includes(answer.name) || answers[answer.name] || answer.type !== 'choice' || !Array.isArray(answer.probabilities)) throw new Error('Invalid or refused Decisions answer.');
    const allowed = Object.keys(predictionQuestions()[answer.name].criteria);
    if (answer.probabilities.length !== allowed.length || !allowed.includes(answer.choice)) throw new Error('Incomplete Decisions probabilities.');
    const probabilities = {};
    for (const item of answer.probabilities) {
      if (!allowed.includes(item.value) || Object.hasOwn(probabilities,item.value) || !Number.isFinite(item.probability) || item.probability < 0 || item.probability > 1) throw new Error('Invalid Decisions probability.');
      probabilities[item.value] = item.probability;
    }
    if (Math.abs(Object.values(probabilities).reduce((sum,p)=>sum+p,0)-1) > 0.02) throw new Error('Invalid Decisions distribution.');
    answers[answer.name] = {choice:answer.choice, probabilities};
  }
  return {...parsePrediction({answers}), model:body.model};
}

export async function predictDecision(match) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.');
  return parseDecision(await jsonFetch('https://api.openai.com/v1/decisions', {
    method:'POST', headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json'},
    body:JSON.stringify(decisionsRequest(match)),
  }));
}
