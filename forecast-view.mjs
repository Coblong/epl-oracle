const escape = value => String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function forecastPanel(match, provider, prediction) {
  const label = provider === 'jev' ? 'Jev' : 'OpenAI Decisions';
  const heading = `<div class="prediction-heading"><strong>${label}</strong></div>`;
  if (!prediction) return `<section class="prediction" aria-label="${label} forecast">${heading}<p class="prediction-pending">No prediction available yet.</p></section>`;
  const outcome = prediction.outcome === 'draw' ? 'Draw' : `${match[prediction.outcome].name} win`;
  const date = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/London',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(prediction.generatedAt));
  return `<section class="prediction" aria-label="${label} forecast">${heading}<div class="forecast-values"><span>Outcome <strong>${escape(outcome)}</strong></span><span>Exact score <strong>${prediction.score.join(' : ')}</strong></span></div><div class="prob-bar" aria-hidden="true">${['home','draw','away'].map(k=>`<span data-weight="${prediction.probabilities[k]}"></span>`).join('')}</div><div class="prob-labels"><span>${escape(match.home.short)} ${Math.round(prediction.probabilities.home*100)}%</span><span>Draw ${Math.round(prediction.probabilities.draw*100)}%</span><span>${escape(match.away.short)} ${Math.round(prediction.probabilities.away*100)}%</span></div><div class="forecast-meta">${escape(prediction.model)}<br><time datetime="${escape(prediction.generatedAt)}">${date} London</time>${prediction.stale ? '<br>Based on earlier fixture information.' : ''}</div></section>`;
}
