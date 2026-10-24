import {fixtureFreshness} from './fixture-freshness.mjs';
import {forecastNotice} from './forecast-view.mjs';
import {renderMatchCard} from './match-card.mjs';
import {renderCompetitionStandings,renderHistoricalLeaderboard} from './leaderboard.mjs';
import {renderGameweekView} from './gameweek-view.mjs';
const $=s=>document.querySelector(s);
let matches=[], limit=30, resultsPage=0,resultsTotal=0,trackRecord=null,selectedGameweek=null;
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(date,options)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',...options}).format(new Date(date));
const dateKey=m=>m.kickoff?fmt(m.kickoff,{year:'numeric',month:'2-digit',day:'2-digit'}):'TBC';
function filtered(){const q=$('#search').value.trim().toLowerCase(),gw=$('#gameweek').value;return matches.filter(m=>(gw==='all'||String(m.gameweek)===gw)&&(!q||`${m.home.name} ${m.away.name}`.toLowerCase().includes(q)));}
function card(m){return renderMatchCard(m);}
function render(){const all=filtered(),visible=all.slice(0,limit);$('#shown-count').textContent=all.length;
const groups=new Map();for(const m of visible){const key=dateKey(m);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(m);}
$('#matches').innerHTML=visible.length?[...groups.values()].map(group=>`<div class="date-heading">${group[0].kickoff?fmt(group[0].kickoff,{weekday:'long',day:'numeric',month:'long',year:'numeric'}):'Date to be confirmed'}<span>${group.length} ${group.length===1?'match':'matches'}</span></div><div class="cards">${group.map(card).join('')}</div>`).join(''):'<div class="empty">No upcoming fixtures match this selection.</div>';document.querySelectorAll('[data-weight]').forEach(el=>el.style.setProperty('--weight',el.dataset.weight));$('#load-more').hidden=visible.length>=all.length;}
function notice(text,error=false){$('#notice').textContent=text;$('#notice').classList.toggle('error',error);}
async function request(url){const r=await fetch(url);const data=await r.json();if(!r.ok)throw new Error(data.error||'Request failed. Please retry.');return data;}
function renderFreshness(updatedAt){const status=fixtureFreshness(updatedAt);const el=$('#fixture-freshness');el.hidden=!status.stale;el.textContent=status.message;}
async function load(){$('#refresh').disabled=true;notice('Fetching official Premier League fixtures…');try{const d=await request('/api/fixtures');matches=d.matches;renderFreshness(d.updatedAt);const previous=$('#gameweek').value;$('#gameweek').innerHTML='<option value="all">All gameweeks</option>'+[...new Set(matches.map(m=>m.gameweek).filter(x=>x!=null))].sort((a,b)=>a-b).map(g=>`<option value="${g}">Gameweek ${g}</option>`).join('');$('#gameweek').value=[...$('#gameweek').options].some(x=>x.value===previous)?previous:'all';$('#fixture-count').textContent=matches.length;$('#updated').textContent=`Updated ${fmt(d.updatedAt,{hour:'2-digit',minute:'2-digit'})} · ${fmt(d.updatedAt,{day:'numeric',month:'short'})}`;render();const message=forecastNotice(d.providersConfigured??{jev:d.configured,openai:false});notice(message.text,message.error);}catch(e){notice(e.message,true);if(!matches.length)$('#matches').innerHTML='<div class="empty">Fixtures are unavailable right now. Use Refresh to try again.</div>';}finally{$('#refresh').disabled=false;}}
function resultRow(r){
  const forecasts=['jev','openai'].map(provider=>{
    const entry=r.forecasts?.[provider];
    if(!entry)return '<td class="missing-forecast">No pre-match forecast</td>';
    const p=entry.prediction,picked=p.outcome==='draw'?'Draw':p.outcome==='home'?'Home win':'Away win';
    const outcomeLabel=`${picked}, ${entry.correctOutcome?'correct':'incorrect'} result prediction`;
    const scoreLabel=`${p.score.join(':')}, ${entry.correctScore?'correct':'incorrect'} exact score prediction`;
    return `<td class="result-prediction"><span class="badge ${entry.correctOutcome?'badge-correct':'badge-wrong'}" aria-label="${escape(outcomeLabel)}" title="${escape(outcomeLabel)}">${picked} ${entry.correctOutcome?'✓':'✗'}</span> <span class="badge ${entry.correctScore?'badge-correct':'badge-wrong'}" aria-label="${escape(scoreLabel)}" title="${escape(scoreLabel)}">${p.score.join(':')} ${entry.correctScore?'✓':'✗'}</span></td>`;
  }).join('');
  const actual=r.status==='cancelled'?'Cancelled':r.actualScore.join(' : ');
  const date=r.kickoff?fmt(r.kickoff,{day:'numeric',month:'short',year:'numeric'}):'TBC';
  const kickoff=r.kickoff?fmt(r.kickoff,{hour:'2-digit',minute:'2-digit'}):'TBC';
  return `<tr><td>${date}</td><td>${kickoff}</td><th scope="row">${escape(r.home.name)} vs ${escape(r.away.name)}</th><td class="result-actual">${actual}</td>${forecasts}</tr>`;
}
function renderScoreboard(){
  if(!trackRecord)return;
  const shared=$('#scoreboard-scope').value==='shared';
  const historical=renderHistoricalLeaderboard(trackRecord,shared?'shared':'full');
  $('#scoreboard-caption').textContent=historical.caption;
  $('#scoreboard-list').innerHTML=historical.rows;
  $('#track-notice').textContent=shared
    ? `Shared scope uses results with eligible forecasts from all agents. Its Brier samples use valid probabilities from every agent. Totals ignore Results pagination.${historical.hasSamples?'':' No scored history is available in this scope.'}`
    : `Full history uses retained completed results across seasons. Accuracy counts submitted forecasts; O Score may include mean-assigned missing forecasts. Totals ignore Results pagination.${historical.hasSamples?'':' No scored history is available in this scope.'}`;
  const competition=renderCompetitionStandings(trackRecord);
  $('#competition-state').textContent=competition.message;
  $('#competition-view').hidden=!competition.active;
  $('#competition-list').innerHTML=competition.rows;
  renderGameweek();
}
function renderGameweek(){
  if(!trackRecord)return;
  const view=renderGameweekView(trackRecord,selectedGameweek);
  selectedGameweek=view.selectedGameweek;
  const select=$('#gameweek-score-scope');
  select.innerHTML=view.options||'<option value="">No gameweeks available</option>';
  select.value=selectedGameweek===null?'':String(selectedGameweek);
  $('#gameweek-score-head').innerHTML=view.headers;
  $('#gameweek-score-list').innerHTML=view.rows;
  $('#gameweek-score-notice').textContent=view.message;
}
async function loadResults(page=1,append=false){
  try{
    const d=await request(`/api/results?page=${page}`);
    if(d.fixtureRefresh)renderFreshness(d.fixtureRefresh.updatedAt);
    resultsPage=d.page;resultsTotal=d.total;
    trackRecord=d;
    renderScoreboard();
    $('#track-notice').classList.remove('error');
    $('#results-notice').classList.remove('error');
    if(!append)$('#results-list').innerHTML='';
    if(d.results.length)$('#results-list').insertAdjacentHTML('beforeend',d.results.map(resultRow).join(''));
    else if(!append)$('#results-list').innerHTML='<tr><td colspan="6" class="empty">No fixtures have finished yet this season.</td></tr>';
    $('#results-notice').textContent=resultsTotal?`Showing ${Math.min(resultsTotal,resultsPage*d.pageSize)} of ${resultsTotal} fixtures.`:'No completed fixtures.';
    $('#results-load-more').hidden=!d.hasMore;
  }catch(e){$('#results-notice').textContent=e.message;$('#results-notice').classList.add('error');$('#track-notice').textContent=e.message;$('#track-notice').classList.add('error');$('#gameweek-score-notice').textContent=e.message;$('#gameweek-score-notice').classList.add('error');}
}
function showView(view){$('#upcoming-view').hidden=view!=='upcoming';$('#results-view').hidden=view!=='results';$('#view-upcoming').setAttribute('aria-pressed',String(view==='upcoming'));$('#view-results').setAttribute('aria-pressed',String(view==='results'));$('#fixture-title').firstChild.textContent=view==='upcoming'?'Predictions':'Results';$('#shown-count').hidden=view!=='upcoming';}
$('#view-upcoming').addEventListener('click',()=>showView('upcoming'));$('#view-results').addEventListener('click',()=>showView('results'));
$('#gameweek').addEventListener('change',()=>{limit=30;render();});$('#search').addEventListener('input',()=>{limit=30;render();});$('#load-more').addEventListener('click',()=>{limit+=30;render();});$('#refresh').addEventListener('click',()=>load());
$('#scoreboard-scope').addEventListener('change',renderScoreboard);
$('#gameweek-score-scope').addEventListener('change',event=>{selectedGameweek=Number(event.target.value)||null;renderGameweek();});
$('#results-load-more').addEventListener('click',()=>loadResults(resultsPage+1,true));
load();loadResults();
