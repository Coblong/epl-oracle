import {AGENT_IDS} from './agents.mjs';
import {summarizeOScoreMatches} from './lib/o-score.mjs';
import {trackRecordSummaries} from './lib/track-record.mjs';
import {rankCompetitionCohort} from './leaderboard.mjs';

const validScore=value=>Array.isArray(value) && value.length===2
  && value.every(goals=>Number.isSafeInteger(goals) && goals>=0);

export function summarizeGameweeks(fixtures,agents=AGENT_IDS){
  const groups=new Map();
  for(const fixture of fixtures){
    const gameweek=Number(fixture.gameweek);
    if(!Number.isInteger(gameweek) || gameweek<1)continue;
    if(!groups.has(gameweek))groups.set(gameweek,[]);
    groups.get(gameweek).push(fixture);
  }
  return [...groups].sort(([a],[b])=>a-b).map(([gameweek,members])=>{
    const cancelled=members.filter(fixture=>fixture.status==='cancelled'||fixture.cancelled===true);
    const completed=members.filter(fixture=>fixture.status==='completed'&&fixture.cancelled!==true
      &&validScore(fixture.actualScore));
    const fixturesCount=members.length-cancelled.length;
    const remaining=fixturesCount-completed.length;
    const completedWithScores=completed.map(fixture=>({
      status:'completed',actualScore:fixture.actualScore,forecasts:fixture.forecasts??{},
    }));
    const accuracyRows=completed.flatMap(fixture=>Object.entries(fixture.forecasts??{}).map(([provider,prediction])=>({
      fixtureId:fixture.id,provider,prediction,actualScore:fixture.actualScore,
    })));
    const comparison=trackRecordSummaries(accuracyRows,agents);
    return {
      gameweek,
      counts:{fixtures:fixturesCount,completed:completed.length,remaining,cancelled:cancelled.length},
      complete:fixturesCount>0&&remaining===0,
      providerSummaries:comparison.providerSummaries,
      sharedComparison:comparison.sharedComparison,
      oScoreSummaries:summarizeOScoreMatches(completedWithScores,agents),
    };
  });
}

export function competitionGameweekStandings(week,competition,agents){
  if(competition?.active!==true||competition.includedFixtureBoundary==null||!week?.competitionSummaries)return [];
  return rankCompetitionCohort(week.competitionSummaries,agents);
}
