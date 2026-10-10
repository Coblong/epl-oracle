import {forecastPanel,forecastNotice} from './forecast-view.mjs';
const $=s=>document.querySelector(s);
let matches=[], limit=30, resultsPage=0,resultsTotal=0;
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(date,options)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',...options}).format(new Date(date));
const dateKey=m=>m.kickoff?fmt(m.kickoff,{year:'numeric',month:'2-digit',day:'2-digit'}):'TBC';
function filtered(){const q=$('#search').value.trim().toLowerCase(),gw=$('#gameweek').value;return matches.filter(m=>(gw==='all'||String(m.gameweek)===gw)&&(!q||`${m.home.name} ${m.away.name}`.toLowerCase().includes(q)));}
function form(team){return `<div class="form" aria-label="Recent form: ${team.recent.map(g=>g.result).join(', ')||'Unavailable'}">${team.recent.map(g=>`<b class="${g.result}">${g.result}</b>`).join('')}</div>`;}
function team(t){return `<div><img class="crest" src="https://resources.premierleague.com/premierleague/badges/t${Number(t.code)}.svg" alt="" loading="lazy"><div class="team-name">${escape(t.name)}</div>${form(t)}</div>`;}
function card(m){const forecasts=m.predictions??{jev:m.prediction};
const status=m.fixtureStatus==='awaiting_rescheduling'?'Awaiting rescheduling':m.fixtureStatus==='awaiting_update'?'Awaiting fixture update':m.fixtureStatus==='awaiting_date'?'Date to be confirmed':m.kickoff?fmt(m.kickoff,{hour:'2-digit',minute:'2-digit'}):'Time TBC';
return `<article class="card" id="match-${m.id}" aria-label="${escape(m.home.name)} versus ${escape(m.away.name)}"><div class="card-top"><span class="gw">GAMEWEEK ${m.gameweek??'TBC'}</span><span>${status}${m.provisional?' · provisional':''}</span></div><div class="teams">${team(m.home)}<div><div class="score waiting">VS</div><div class="score-caption">FIXTURE</div></div>${team(m.away)}</div>${['jev','openai'].map(provider=>forecastPanel(m,provider,forecasts[provider],m.forecastStates?.[provider])).join('')}</article>`;}
function render(){const all=filtered(),visible=all.slice(0,limit);$('#shown-count').textContent=all.length;
const groups=new Map();for(const m of visible){const key=dateKey(m);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(m);}
$('#matches').innerHTML=visible.length?[...groups.values()].map(group=>`<div class="date-heading">${group[0].kickoff?fmt(group[0].kickoff,{weekday:'long',day:'numeric',month:'long',year:'numeric'}):'Date to be confirmed'}<span>${group.length} ${group.length===1?'match':'matches'}</span></div><div class="cards">${group.map(card).join('')}</div>`).join(''):'<div class="empty">No upcoming fixtures match this selection.</div>';document.querySelectorAll('[data-weight]').forEach(el=>el.style.setProperty('--weight',el.dataset.weight));$('#load-more').hidden=visible.length>=all.length;}
function notice(text,error=false){$('#notice').textContent=text;$('#notice').classList.toggle('error',error);}
async function request(url){const r=await fetch(url);const data=await r.json();if(!r.ok)throw new Error(data.error||'Request failed. Please retry.');return data;}
async function load(){$('#refresh').disabled=true;notice('Fetching official Premier League fixtures…');try{const d=await request('/api/fixtures');matches=d.matches;const previous=$('#gameweek').value;$('#gameweek').innerHTML='<option value="all">All gameweeks</option>'+[...new Set(matches.map(m=>m.gameweek).filter(x=>x!=null))].sort((a,b)=>a-b).map(g=>`<option value="${g}">Gameweek ${g}</option>`).join('');$('#gameweek').value=[...$('#gameweek').options].some(x=>x.value===previous)?previous:'all';$('#fixture-count').textContent=matches.length;$('#updated').textContent=`Updated ${fmt(d.updatedAt,{hour:'2-digit',minute:'2-digit'})} · ${fmt(d.updatedAt,{day:'numeric',month:'short'})}`;render();const message=forecastNotice(d.providersConfigured??{jev:d.configured,openai:false});notice(message.text,message.error);}catch(e){notice(e.message,true);if(!matches.length)$('#matches').innerHTML='<div class="empty">Fixtures are unavailable right now. Use Refresh to try again.</div>';}finally{$('#refresh').disabled=false;}}
function resultRow(r){
  const forecasts=['jev','openai'].map(provider=>{
    const entry=r.forecasts?.[provider],label=provider==='openai'?'OpenAI':'Jev';
    if(!entry)return `<div class="result-forecast"><strong>${label}</strong><span class="missing-forecast">No pre-match forecast</span></div>`;
    const p=entry.prediction,picked=p.outcome==='draw'?'Draw':`${p.outcome==='home'?r.home.name:r.away.name} win`;
    return `<div class="result-forecast"><strong>${label}</strong><span>Outcome: ${escape(picked)} · Score: ${p.score.join(':')}</span><span class="badge ${entry.correctOutcome?'badge-correct':'badge-wrong'}">${entry.correctOutcome?'✓':'✗'} outcome</span><span class="badge ${entry.correctScore?'badge-correct':'badge-wrong'}">${entry.correctScore?'✓':'✗'} exact score</span></div>`;
  }).join('');
  const actual=r.status==='cancelled'?'Cancelled':r.actualScore.join(' : ');
  return `<article class="result-row"><div class="result-heading"><div class="result-teams"><span>${escape(r.home.name)}</span><span class="result-score">${actual}</span><span>${escape(r.away.name)}</span></div><span class="result-date">${r.kickoff?fmt(r.kickoff,{weekday:'short',day:'numeric',month:'short',year:'numeric'}):'Date to be confirmed'}</span></div><div class="result-forecasts">${forecasts}</div></article>`;
}
async function loadResults(page=1,append=false){
  try{
    const d=await request(`/api/results?page=${page}`),s=d.summary;
    resultsPage=d.page;resultsTotal=d.total;
    $('#tr-resolved').textContent=s.resolved;$('#tr-outcome').textContent=s.resolved?`${Math.round(s.outcomeAccuracy*100)}%`:'—';$('#tr-score').textContent=s.resolved?`${Math.round(s.scoreAccuracy*100)}%`:'—';
    $('#track-notice').textContent=s.resolved?`${s.outcomeCorrect} of ${s.resolved} outcomes correct · ${s.scoreCorrect} exact scores.`:'No predicted fixtures have finished yet.';
    if(!append)$('#results-list').innerHTML='';
    if(d.results.length)$('#results-list').insertAdjacentHTML('beforeend',d.results.map(resultRow).join(''));
    else if(!append)$('#results-list').innerHTML='<div class="empty">No fixtures have finished yet this season.</div>';
    $('#results-notice').textContent=resultsTotal?`Showing ${Math.min(resultsTotal,resultsPage*d.pageSize)} of ${resultsTotal} fixtures.`:'No completed fixtures.';
    $('#results-load-more').hidden=!d.hasMore;
  }catch(e){$('#results-notice').textContent=e.message;$('#results-notice').classList.add('error');$('#track-notice').textContent=e.message;$('#track-notice').classList.add('error');}
}
function showView(view){$('#upcoming-view').hidden=view!=='upcoming';$('#results-view').hidden=view!=='results';$('#view-upcoming').setAttribute('aria-pressed',String(view==='upcoming'));$('#view-results').setAttribute('aria-pressed',String(view==='results'));$('#fixture-title').firstChild.textContent=view==='upcoming'?'Upcoming fixtures':'Results';$('#shown-count').hidden=view!=='upcoming';}
$('#view-upcoming').addEventListener('click',()=>showView('upcoming'));$('#view-results').addEventListener('click',()=>showView('results'));
$('#gameweek').addEventListener('change',()=>{limit=30;render();});$('#search').addEventListener('input',()=>{limit=30;render();});$('#load-more').addEventListener('click',()=>{limit+=30;render();});$('#refresh').addEventListener('click',()=>load());
$('#results-load-more').addEventListener('click',()=>loadResults(resultsPage+1,true));
load();loadResults();
