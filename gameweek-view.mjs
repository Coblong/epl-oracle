import {AGENTS} from './agents.mjs';
import {rankCompetitionCohort} from './leaderboard.mjs';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>Number.isFinite(value)?value.toFixed(3):'—';
const percent=(value,count)=>Number.isFinite(value)&&count>0?`${Math.round(value*100)}%`:'—';

export function renderGameweekView(data,selectedGameweek=null){
  const agents=data?.agents??AGENTS;
  const competition=data?.competition;
  const allWeeks=data?.gameweeks??[];
  const weeks=competition?.active===true
    ? allWeeks.filter(week=>week.competitionCounts
      ? week.competitionCounts.fixtures>0
      : week.counts.fixtures>0)
    : allWeeks;
  const fallback=weeks.find(week=>week.counts.remaining>0)?.gameweek??weeks.at(-1)?.gameweek??null;
  const selected=weeks.some(week=>week.gameweek===Number(selectedGameweek))?Number(selectedGameweek):fallback;
  const week=weeks.find(item=>item.gameweek===selected);
  const options=weeks.map(item=>`<option value="${item.gameweek}"${item.gameweek===selected?' selected':''}>Gameweek ${item.gameweek}</option>`).join('');
  const active=competition?.active===true&&competition.includedFixtureBoundary!=null&&Boolean(week?.competitionSummaries);
  const ranked=active?rankCompetitionCohort(week.competitionSummaries,agents):[];
  const byAgent=new Map(ranked.map(row=>[row.id,row]));
  const displayAgents=active
    ? [...ranked.map(row=>agents.find(agent=>agent.id===row.id)).filter(Boolean),...agents.filter(agent=>!byAgent.has(agent.id))]
    : agents;
  const rows=week?displayAgents.map(agent=>{
    const summary=active?byAgent.get(agent.id):null;
    const historic=week.providerSummaries?.[agent.id]??{};
    const sharedBrier=week.sharedComparison?.providerSummaries?.[agent.id]??{};
    const oscore=week.oScoreSummaries?.[agent.id]??{};
    const scoreDetails=(active?summary:oscore)??{};
    const accuracy=active?summary:historic;
    const rank=active?`<td>${summary?.rank??'—'}</td>`:'';
    const brier=active?accuracy?.brierScore:sharedBrier.brierScore;
    const brierSamples=active?accuracy?.brierSampleCount:sharedBrier.brierSampleCount;
    const hasOScore=scoreDetails.sampleCount>0;
    const total=hasOScore?number(scoreDetails.total):'—';
    const average=hasOScore?number(scoreDetails.average):'—';
    return `<tr>${rank}<th scope="row">${escape(agent.name)}</th><td>${total}<small>${scoreDetails.submittedCount??0} submitted · ${scoreDetails.missingCount??0} missing</small><small>${scoreDetails.earnedCount??0} earned · ${scoreDetails.meanAssignedCount??0} mean-assigned · ${scoreDetails.sampleCount??0} scored</small></td><td>${average}<small>per scored match</small></td><td>${percent(accuracy?.outcomeAccuracy,accuracy?.resolved??0)}<small>${accuracy?.outcomeCorrect??0} of ${accuracy?.resolved??0} forecasts</small></td><td>${percent(accuracy?.scoreAccuracy,accuracy?.resolved??0)}<small>${accuracy?.scoreCorrect??0} of ${accuracy?.resolved??0} forecasts</small></td><td>${Number.isFinite(brier)?brier.toFixed(3):'—'}<small>${brierSamples??0} shared probability samples</small></td></tr>`;
  }).join(''):`<tr><td colspan="6" class="leaderboard-empty">No current-season gameweek data is available.</td></tr>`;
  let message='No current-season gameweek data is available.';
  if(week){
    const counts=week.counts;
    if(!active)message=`Competition has not started. Historical gameweek statistics are shown. ${counts.completed} completed, ${counts.remaining} remaining, ${counts.cancelled} cancelled.`;
    else if(!(week.competitionComplete??week.complete)){
      const activeCounts=week.competitionCounts??counts;
      message=`Provisional standings. ${activeCounts.completed} of ${activeCounts.fixtures} active fixtures completed, ${activeCounts.remaining} remaining, ${activeCounts.cancelled} cancelled.`;
    }
    else if(!ranked.length)message='Round complete. No agent has an O Score sample for this gameweek.';
    else {
      const winners=ranked.filter(row=>row.rank===1).map(row=>row.name);
      message=`Gameweek ${week.gameweek} winner${winners.length===1?'':'s'}: ${winners.join(' and ')}.`;
    }
  }
  return {selectedGameweek:selected,options,active,headers:`<tr>${active?'<th scope="col">RANK</th>':''}<th scope="col">AGENT</th><th scope="col">TOTAL O SCORE</th><th scope="col">AVERAGE O SCORE</th><th scope="col">CORRECT RESULT</th><th scope="col">EXACT SCORE</th><th scope="col">BRIER SCORE</th></tr>`,rows,message};
}
