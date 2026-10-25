import {AGENTS} from './agents.mjs';
import {outcomeBrier} from './lib/track-record.mjs';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(date,options)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',...options}).format(new Date(date));
const number=value=>Number.isFinite(value)?String(Number(value.toFixed(3))):'—';
const count=value=>Number.isInteger(value)&&value>=0?String(value):'—';

function outcomeName(outcome,match){
  if(outcome==='draw')return 'Draw';
  if(outcome==='home')return `${match.home.name} win`;
  if(outcome==='away')return `${match.away.name} win`;
  return 'Unknown result';
}

function oscoreDetails(score,status){
  if(status==='cancelled')return 'Cancelled fixtures are not scored.';
  if(score?.source==='earned')return `<dl class="result-breakdown"><div><dt>Home-goal error</dt><dd>${count(score.homeGoalError)}</dd></div><div><dt>Away-goal error</dt><dd>${count(score.awayGoalError)}</dd></div><div><dt>Result penalty</dt><dd>${count(score.resultPenalty)}</dd></div></dl>`;
  if(score?.source==='mean_assigned')return '<p>The O Score is the mean of earned O Scores on this match. No forecast is assigned.</p>';
  return 'No earned O Score exists for this match.';
}

function forecastDetails(entry,match){
  if(!entry)return '<p>No pre-match forecast was recorded for this agent.</p><p>Brier score: unavailable.</p>';
  const prediction=entry.prediction??{};
  const probabilities=prediction.probabilities;
  const brier=match.status==='completed'&&match.actualOutcome
    ?outcomeBrier(prediction,match.actualOutcome):null;
  const probabilityView=probabilities
    ?`<div class="result-probabilities"><span>Home ${Number.isFinite(probabilities.home)?Math.round(probabilities.home*100):'—'}%</span><span>Draw ${Number.isFinite(probabilities.draw)?Math.round(probabilities.draw*100):'—'}%</span><span>Away ${Number.isFinite(probabilities.away)?Math.round(probabilities.away*100):'—'}%</span></div>`
    :'<p>Probabilities unavailable.</p>';
  const brierText=Number.isFinite(brier)?`${brier.toFixed(3)} (three-outcome sum)`:'unavailable for missing or invalid probabilities';
  const generated=prediction.generatedAt
    ?`<time datetime="${escape(prediction.generatedAt)}">${fmt(prediction.generatedAt,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})} London</time>`
    :'Not generated';
  return `${probabilityView}<p>Brier score: ${brierText}.</p><p>Model: ${escape(prediction.model??'Unavailable')}</p><p>Predicted: ${generated}</p>`;
}

function agentRow(match,agent){
  const forecast=match.forecasts?.[agent.id];
  const prediction=forecast?.prediction;
  const score=match.oScores?.[agent.id];
  const scoreAvailable=match.status==='completed'&&score?.value!==null&&Number.isFinite(score?.value);
  const scoreValue=scoreAvailable?number(score.value):'—';
  const scoreSource=scoreAvailable&&score.source==='earned'?'Earned':scoreAvailable&&score.source==='mean_assigned'?'Other agents\' mean':'Unscored';
  const predictedOutcome=prediction?outcomeName(prediction.outcome,match):'No prediction';
  const predictedScore=Array.isArray(prediction?.score)?prediction.score.join(' : '):'';
  const predictionLabel=prediction?`${predictedOutcome}, predicted score ${predictedScore}`:`No prediction from ${agent.name}`;
  const outcomeIndicator=forecast?`<span class="badge ${forecast.correctOutcome?'badge-correct':'badge-wrong'}" aria-label="${forecast.correctOutcome?'Correct':'Incorrect'} result prediction">Result ${forecast.correctOutcome?'✓':'✗'}</span>`:'';
  const exactIndicator=forecast?`<span class="badge ${forecast.correctScore?'badge-correct':'badge-wrong'}" aria-label="${forecast.correctScore?'Correct':'Incorrect'} exact score prediction">Exact ${forecast.correctScore?'✓':'✗'}</span>`:'';
  const predictionView=forecast
    ?`<div class="agent-score result-prediction" aria-label="${escape(agent.name)}: ${escape(predictionLabel)}"><span>${escape(predictedOutcome)}</span><strong>${escape(predictedScore||'—')}</strong><span class="result-indicators">${outcomeIndicator}${exactIndicator}</span></div>`
    :`<div class="agent-score result-prediction" aria-label="${escape(agent.name)}: no prediction"><span class="no-forecast">No prediction</span></div>`;
  return `<section class="agent-row result-agent-row" aria-label="${escape(agent.name)} result"><div class="agent-identity"><strong>${escape(agent.name)}</strong></div>${predictionView}<div class="result-oscore"><span>O Score</span><strong>${scoreValue}</strong><small>${scoreSource}</small></div><details class="agent-details result-details"><summary>Details</summary>${oscoreDetails(score,match.status)}${forecastDetails(forecast,match)}</details></section>`;
}

export function renderResultCard(match,agents=AGENTS){
  const gameweek=match.gameweek==null?'TBC':match.gameweek;
  const date=match.kickoff
    ?`${fmt(match.kickoff,{day:'numeric',month:'short',year:'numeric'})} · ${fmt(match.kickoff,{hour:'2-digit',minute:'2-digit'})} London`
    :'Date and time TBC';
  const score=match.status==='cancelled'?'Cancelled':Array.isArray(match.actualScore)?match.actualScore.join(' : '):'Unscored';
  const scoreLabel=match.status==='cancelled'?'Cancelled fixture':Array.isArray(match.actualScore)?`Final score ${score}`:'Result unavailable';
  const rows=agents.map(agent=>agentRow(match,agent)).join('');
  return `<article class="card result-card" aria-label="${escape(match.home.name)} versus ${escape(match.away.name)}"><header class="card-top result-card-heading"><span class="gw">GAMEWEEK ${escape(gameweek)}</span><time class="result-date" datetime="${escape(match.kickoff??'')}">${escape(date)}</time></header><div class="result-scoreline" aria-label="${escape(scoreLabel)}"><span>${escape(match.home.name)}</span><strong>${escape(score)}</strong><span>${escape(match.away.name)}</span></div><div class="result-agent-rows">${rows}</div></article>`;
}

export function resultsCompetitionNotice(competition){
  return competition?.active===false
    ?'The competition has not started. Historical statistics are shown below.'
    :'';
}
