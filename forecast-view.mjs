import {AGENTS} from './agents.mjs';
const escape = value => String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const formatNames = names => names.length < 2 ? names[0] ?? '' : `${names.slice(0,-1).join(', ')} and ${names.at(-1)}`;
export function forecastNotice(providers) {
  const enabled = AGENTS.filter(agent=>providers[agent.id]);
  if (!enabled.length) return {text:'Official fixtures · Forecasts are currently unavailable.', error:true};
  const unavailable = AGENTS.filter(agent=>!providers[agent.id]).map(agent=>agent.name);
  const names=formatNames(enabled.map(agent=>agent.name));
  const unavailableText=unavailable.length?` ${formatNames(unavailable)} ${unavailable.length===1?'is':'are'} currently unavailable.`:'';
  return {text:`Official fixtures · Forecasts from ${names} for the next ten days update automatically each Wednesday, starting between 09:00 and 09:59 London time.${unavailableText}`, error:false};
}

export function forecastAvailability(forecast, attempt, expectedRunKey, stale = false) {
  if (!forecast) return 'missing';
  return stale || forecast.runKey !== expectedRunKey || attempt && attempt.runId !== forecast.runId ? 'retained' : 'fresh';
}

export function forecastPanel(match, provider, prediction, state = {}) {
  const label = provider === 'jev' ? 'Jev' : 'OpenAI';
  const heading = `<div class="prediction-heading"><strong>${label}</strong></div>`;
  const status = {failed:'Refresh failed.',exhausted:'Retries exhausted.',expired:'Retry window expired.'}[state.status] ?? '';
  const count = state.attemptCount > 0 ? ` Attempt ${state.attemptCount} of 3.` : '';
  const statusText = status && state.availability === 'retained' ? `<p class="forecast-status">${status} Retaining the earlier forecast.${count}${state.status === 'failed' ? ' Waiting for a scheduled retry.' : ''}</p>` : '';
  if (!prediction) return '';
  const outcome = prediction.outcome === 'draw' ? 'Draw' : `${match[prediction.outcome].name} win`;
  const date = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/London',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(prediction.generatedAt));
  return `<section class="prediction" aria-label="${label} forecast">${heading}${statusText}<div class="forecast-values"><span>Predicted result<strong>${escape(outcome)}</strong></span><span>Predicted score<strong>${prediction.score.join(' : ')}</strong></span></div><details class="prediction-details"><summary class="probability-row" aria-label="${label} prediction probabilities"><span class="probability-content"><span class="prob-bar" aria-hidden="true">${['home','draw','away'].map(k=>`<span data-weight="${prediction.probabilities[k]}"></span>`).join('')}</span><span class="prob-labels"><span>${escape(match.home.short)} ${Math.round(prediction.probabilities.home*100)}%</span><span>Draw ${Math.round(prediction.probabilities.draw*100)}%</span><span>${escape(match.away.short)} ${Math.round(prediction.probabilities.away*100)}%</span></span></span><span class="probability-chevron" aria-hidden="true"></span></summary><div class="forecast-meta"><time datetime="${escape(prediction.generatedAt)}">${date} London</time>${prediction.stale ? '<br>Based on earlier fixture information.' : ''}</div></details></section>`;
}
