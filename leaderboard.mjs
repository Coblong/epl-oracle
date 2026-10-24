import {AGENTS} from './agents.mjs';

export function rankCompetitionCohort(summaries,agents=AGENTS){
  const scored=agents.flatMap(agent=>{
    const summary=summaries?.[agent.id];
    if(!summary || !Number.isFinite(summary.total) || !Number.isInteger(summary.sampleCount) || summary.sampleCount<=0)return [];
    return [{...summary,id:agent.id,name:agent.name}];
  }).sort((a,b)=>a.total-b.total);
  let priorTotal=null,priorRank=0;
  return scored.map((row,index)=>{
    if(priorTotal===null || Math.abs(row.total-priorTotal)>1e-12){
      priorTotal=row.total;
      priorRank=index+1;
    }
    const rank=priorRank;
    return {...row,rank};
  });
}

export function competitionLeaderboard(data){
  const competition=data?.competition;
  const active=competition?.active===true
    && competition.includedFixtureBoundary!==null
    && competition.includedFixtureBoundary!==undefined
    && Boolean(data?.competitionSummaries);
  return {active,rows:active?rankCompetitionCohort(data.competitionSummaries,data.agents??AGENTS):[]};
}

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>Number.isFinite(value)?value.toFixed(3):'—';
const percent=(value,count)=>Number.isFinite(value)&&count>0?`${Math.round(value*100)}%`:'—';

export function renderHistoricalLeaderboard(data,scope='full'){
  const agents=data?.agents??AGENTS;
  const shared=scope==='shared';
  const summaries=shared?data?.sharedComparison?.providerSummaries:data?.providerSummaries;
  const oScores=shared?data?.sharedComparison?.oScoreDiagnostics?.providerSummaries:null;
  const caption=shared
    ? `Results with eligible forecasts from all ${agents.length} agents.`
    : 'Full history of retained completed results.';
  const rows=agents.map(agent=>{
    const summary=summaries?.[agent.id];
    const oScore=shared?oScores?.[agent.id]:summary?.oScoreDiagnostics;
    const count=summary?.resolved??0;
    const total=oScore?.sampleCount>0?number(oScore.total):'—';
    const average=oScore?.sampleCount>0?number(oScore.average):'—';
    return `<tr><th scope="row">${escape(agent.name)}</th><td>${total}<small>${oScore?.submittedCount??0} submitted · ${oScore?.missingCount??0} missing</small><small>${oScore?.earnedCount??0} earned · ${oScore?.meanAssignedCount??0} mean-assigned · ${oScore?.sampleCount??0} scored</small></td><td>${average}<small>per scored match</small></td><td>${percent(summary?.outcomeAccuracy,count)}<small>${summary?.outcomeCorrect??0} of ${count} forecasts</small></td><td>${percent(summary?.scoreAccuracy,count)}<small>${summary?.scoreCorrect??0} of ${count} forecasts</small></td><td>${Number.isFinite(summary?.brierScore)?summary.brierScore.toFixed(3):'—'}<small>${summary?.brierSampleCount??0} probability samples</small></td></tr>`;
  }).join('');
  const hasSamples=agents.some(agent=>(summaries?.[agent.id]?.resolved??0)>0 || (oScores?.[agent.id]?.sampleCount??summaries?.[agent.id]?.oScoreDiagnostics?.sampleCount??0)>0);
  const empty=!hasSamples?`<tr><td class="leaderboard-empty" colspan="6">No completed matches have eligible forecasts in this scope yet.</td></tr>`:'';
  return {caption,rows:empty+rows,hasSamples};
}

export function renderCompetitionStandings(data){
  const view=competitionLeaderboard(data);
  if(!view.active)return {active:false,rows:'',message:'The competition has not started. Historical statistics are shown below.'};
  if(!view.rows.length)return {active:true,rows:'<tr><td class="leaderboard-empty" colspan="7">No scored competition matches are available yet.</td></tr>',message:'No scored competition matches are available yet.'};
  const rows=view.rows.map(agent=>`<tr><td>${agent.rank}</td><th scope="row">${escape(agent.name)}</th><td>${number(agent.total)}<small>${agent.submittedCount??0} submitted · ${agent.missingCount??0} missing</small><small>${agent.earnedCount??0} earned · ${agent.meanAssignedCount??0} mean-assigned · ${agent.sampleCount} scored</small></td><td>${number(agent.average)}<small>per scored match</small></td><td>${percent(agent.outcomeAccuracy,agent.resolved??0)}<small>${agent.outcomeCorrect??0} of ${agent.resolved??0} forecasts</small></td><td>${percent(agent.scoreAccuracy,agent.resolved??0)}<small>${agent.scoreCorrect??0} of ${agent.resolved??0} forecasts</small></td><td>${Number.isFinite(agent.brierScore)?agent.brierScore.toFixed(3):'—'}<small>${agent.brierSampleCount??0} probability samples</small></td></tr>`).join('');
  return {active:true,rows,message:'These rankings use the active competition cohort. Lower O Score is better. Equal totals share a rank.'};
}
