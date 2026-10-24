import {AGENTS} from './agents.mjs';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(date,options)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',...options}).format(new Date(date));

function team(t){
  const recent=t.recent??[];
  const form=`<div class="form" aria-label="Recent form: ${escape(recent.map(g=>g.result).join(', ')||'Unavailable')}">${recent.map(g=>`<b class="${escape(g.result)}">${escape(g.result)}</b>`).join('')}</div>`;
  return `<div><img class="crest" src="https://resources.premierleague.com/premierleague/badges/t${Number(t.code)}.svg" alt="" loading="lazy"><div class="team-name">${escape(t.name)}</div>${form}</div>`;
}

function fixtureStatus(match){
  if(['awaiting_result','in_progress'].includes(match.fixtureStatus))return 'Awaiting result';
  if(match.fixtureStatus==='awaiting_rescheduling')return 'Awaiting rescheduling';
  if(match.fixtureStatus==='awaiting_update')return 'Awaiting fixture update';
  if(match.fixtureStatus==='awaiting_date')return 'Date to be confirmed';
  return match.kickoff?fmt(match.kickoff,{hour:'2-digit',minute:'2-digit'}):'Time TBC';
}

function agentRow(match,agent,forecast,state={}){
  const availability=state.availability??(forecast?'fresh':'missing');
  const statuses={failed:'Refresh failed.',exhausted:'Retries exhausted.',expired:'Retry window expired.',started:'Refresh in progress.',pending:'Waiting for a scheduled retry.'};
  const status=statuses[state.status]??'';
  const count=state.attemptCount>0?` Attempt ${state.attemptCount} of 3.`:'';
  const retained=availability==='retained';
  const terminalMissing=availability==='missing'&&['exhausted','expired'].includes(state.status);
  const label=retained?'Retained forecast':availability==='fresh'?'Fresh forecast':terminalMissing?'No prediction':'No prediction yet';
  const result=forecast?forecast.outcome==='draw'?'Draw':`${match[forecast.outcome]?.name??'Unknown'} win`:'';
  const score=forecast?.score?.join(' : ')??'';
  const generated=forecast?.generatedAt??'';
  const probabilities=forecast?.probabilities;
  const probabilityText=probabilities?`<div class="agent-probabilities"><span>${escape(match.home.short)} ${Math.round(probabilities.home*100)}%</span><span>Draw ${Math.round(probabilities.draw*100)}%</span><span>${escape(match.away.short)} ${Math.round(probabilities.away*100)}%</span></div>`:'<p>Probabilities unavailable.</p>';
  const time=generated?`<time datetime="${escape(generated)}">${fmt(generated,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})} London</time>`:'Not generated';
  const freshness=forecast?.stale?'Based on earlier fixture information.':'Based on current fixture information.';
  const retries=status?`${status}${retained?' Earlier forecast retained.':''}${count}${state.status==='failed'?' Waiting for a scheduled retry.':''}`:`No retry pending.${count}`;
  const details=forecast?`<details class="agent-details"><summary>Forecast details</summary>${probabilityText}<p>Model: ${escape(forecast.model??'Unavailable')}</p><p>Generated: ${time}</p><p>${freshness}</p><p>${escape(retries)}</p>${state.nextAttemptAt?`<p>Next retry: <time datetime="${escape(state.nextAttemptAt)}">${fmt(state.nextAttemptAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} London</time></p>`:''}</details>`:`<details class="agent-details"><summary>Forecast details</summary><p>${escape(retries)}</p>${state.nextAttemptAt?`<p>Next retry: <time datetime="${escape(state.nextAttemptAt)}">${fmt(state.nextAttemptAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} London</time></p>`:''}</details>`;
  return `<section class="agent-row" aria-label="${escape(agent.name)} forecast"><div class="agent-identity"><strong>${escape(agent.name)}</strong><span class="forecast-state ${availability}">${label}</span></div><div class="agent-score">${forecast?`<span>Predicted result: ${escape(result)}</span><strong>Predicted score: ${escape(score)}</strong>`:'<span class="no-forecast">—</span>'}</div>${details}</section>`;
}

export function renderMatchCard(match){
  const forecasts=match.predictions??{jev:match.prediction};
  const status=fixtureStatus(match);
  return `<article class="card" id="match-${escape(match.id)}" aria-label="${escape(match.home.name)} versus ${escape(match.away.name)}"><div class="card-top"><span class="gw">GAMEWEEK ${escape(match.gameweek??'TBC')}</span><span>${escape(status)}${match.provisional?' · provisional':''}</span></div><div class="teams">${team(match.home)}<div><div class="score waiting">VS</div><div class="score-caption">FIXTURE</div></div>${team(match.away)}</div><div class="agent-rows">${AGENTS.map(agent=>agentRow(match,agent,forecasts[agent.id],match.forecastStates?.[agent.id])).join('')}</div></article>`;
}
