import {deriveScorePrediction, predictionEvidence, predictionQuestions} from './football.mjs';

export function forecastPrompt(match) {
  return JSON.stringify({evidence:predictionEvidence(match),question:predictionQuestions().score,
    response:'Return only a JSON object with scoreProbabilities containing all 49 score keys and probabilities summing to one.'});
}

export function forecastSchema() {
  const keys=Object.keys(predictionQuestions().score.criteria);
  return {type:'object',additionalProperties:false,required:['scoreProbabilities'],properties:{scoreProbabilities:{
    type:'object',additionalProperties:false,required:keys,
    properties:Object.fromEntries(keys.map(key=>[key,{type:'number',minimum:0,maximum:1}]))}}};
}

export function parseStructuredForecast(text, metadata) {
  try {
    if (typeof metadata.model!=='string' || !metadata.model.trim()) throw new Error('Missing actual model.');
    const parsed=JSON.parse(text);
    if (!parsed || Object.keys(parsed).length!==1 || !Object.hasOwn(parsed,'scoreProbabilities')) throw new Error('Invalid forecast object.');
    return {...deriveScorePrediction(parsed.scoreProbabilities),generatedAt:new Date().toISOString(),...metadata};
  } catch {
    throw Object.assign(new Error('Provider returned an invalid score distribution.'),{predictionMetadata:metadata});
  }
}
