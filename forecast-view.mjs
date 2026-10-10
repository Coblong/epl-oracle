const escape = value => String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function forecastNotice(providers) {
  const enabled = ['jev','openai'].filter(provider=>providers[provider]);
  if (!enabled.length) return {text:'Official fixtures · Forecasts are currently unavailable.', error:true};
  const names = enabled.map(provider=>provider==='jev'?'Jev':'OpenAI Decisions').join(' and ');
  const unavailable = enabled.length === 1 ? ` ${enabled[0]==='jev'?'OpenAI Decisions':'Jev'} is currently unavailable.` : '';
  return {text:`Official fixtures · ${names} forecasts for the next ten days update automatically each Wednesday, starting between 09:00 and 09:59 London time.${unavailable}`, error:false};
}

export function forecastPanel(match, provider, prediction, state = {}) {
  const label = provider === 'jev' ? 'Jev' : 'OpenAI Decisions';
  const heading = `<div class="prediction-heading"><strong>${label}</strong></div>`;
  const status = {failed:'Refresh failed.',started:'Refresh in progress.',succeeded:'Latest refresh succeeded.',exhausted:'Retries exhausted.',expired:'Retry window expired.'}[state.status] ?? '';
  const count = state.attemptCount > 0 ? ` Attempt ${state.attemptCount} of 3.` : '';
  const statusText = status ? `<p class="forecast-status">${status}${prediction && state.availability === 'retained' ? ' Retaining the earlier forecast.' : ''}${count}${state.status === 'failed' ? ' Waiting for a scheduled retry.' : ''}</p>` : '';
  if (!prediction) return `<section class="prediction" aria-label="${label} forecast">${heading}<p class="prediction-pending">No prediction available yet.</p>${statusText}</section>`;
  const outcome = prediction.outcome === 'draw' ? 'Draw' : `${match[prediction.outcome].name} win`;
  const date = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/London',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(prediction.generatedAt));
  return `<section class="prediction" aria-label="${label} forecast">${heading}${statusText}<div class="forecast-values"><span>Outcome <strong>${escape(outcome)}</strong></span><span>Exact score <strong>${prediction.score.join(' : ')}</strong></span></div><div class="prob-bar" aria-hidden="true">${['home','draw','away'].map(k=>`<span data-weight="${prediction.probabilities[k]}"></span>`).join('')}</div><div class="prob-labels"><span>${escape(match.home.short)} ${Math.round(prediction.probabilities.home*100)}%</span><span>Draw ${Math.round(prediction.probabilities.draw*100)}%</span><span>${escape(match.away.short)} ${Math.round(prediction.probabilities.away*100)}%</span></div><div class="forecast-meta">${escape(prediction.model)}<br><time datetime="${escape(prediction.generatedAt)}">${date} London</time>${prediction.stale ? '<br>Based on earlier fixture information.' : ''}</div></section>`;
}
