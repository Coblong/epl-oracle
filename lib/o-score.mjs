import {AGENT_IDS} from '../agents.mjs';
import {matchOutcome} from './football.mjs';

export const O_SCORE_RULES=Object.freeze({
  id:'oracle-score-v1',
  name:'Oracle score',
  better:'lower',
  formula:'Absolute home-goal error + absolute away-goal error + 1 when the predicted result differs.',
  missingForecast:'The arithmetic mean of earned O Scores for the same match.',
});

const unavailable = () => ({value:null,source:'unavailable',homeGoalError:null,awayGoalError:null,resultPenalty:null});
const validScore = score => Array.isArray(score) && score.length===2
  && score.every(goals=>Number.isSafeInteger(goals) && goals>=0);
const validPrediction = prediction => ['home','draw','away'].includes(prediction?.outcome)
  && validScore(prediction?.score);

export function scoreMatchOScore(forecasts,actualScore,agents=AGENT_IDS) {
  const scores={};
  const actualValid=validScore(actualScore);
  let earnedTotal=0,earnedCount=0;
  if(actualValid) for(const agent of agents){
    const prediction=forecasts?.[agent];
    if(!validPrediction(prediction)) continue;
    const homeGoalError=Math.abs(prediction.score[0]-actualScore[0]);
    const awayGoalError=Math.abs(prediction.score[1]-actualScore[1]);
    const resultPenalty=prediction.outcome===matchOutcome(...actualScore)?0:1;
    const value=homeGoalError+awayGoalError+resultPenalty;
    scores[agent]={value,source:'earned',homeGoalError,awayGoalError,resultPenalty};
    earnedTotal+=value;
    earnedCount++;
  }
  const mean=earnedCount?earnedTotal/earnedCount:null;
  for(const agent of agents){
    if(scores[agent]) continue;
    scores[agent]=actualValid && mean!==null
      ? {value:mean,source:'mean_assigned',homeGoalError:null,awayGoalError:null,resultPenalty:null}
      : unavailable();
  }
  return scores;
}

export function summarizeOScoreMatches(matches,agents=AGENT_IDS) {
  const summaries=Object.fromEntries(agents.map(agent=>[agent,{earnedCount:0,meanAssignedCount:0,sampleCount:0,total:0,average:null}]));
  for(const match of matches){
    if(match.status && match.status!=='completed') continue;
    const scores=scoreMatchOScore(match.forecasts,match.actualScore,agents);
    for(const agent of agents){
      const score=scores[agent];
      if(score.source==='unavailable') continue;
      const summary=summaries[agent];
      if(score.source==='earned') summary.earnedCount++;
      else summary.meanAssignedCount++;
      summary.sampleCount++;
      summary.total+=score.value;
    }
  }
  for(const summary of Object.values(summaries)) if(summary.sampleCount) summary.average=summary.total/summary.sampleCount;
  return summaries;
}
