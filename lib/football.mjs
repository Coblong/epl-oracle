export function buildFixtures(fixtures, teams, now = Date.now()) {
  const byId = new Map(teams.map(t => [t.id, t]));
  const completed = fixtures.filter(f => f.finished && f.kickoff_time && Date.parse(f.kickoff_time) < now && Number.isInteger(f.team_h_score) && Number.isInteger(f.team_a_score));
  const team = id => {
    const t = byId.get(id);
    if (!t) throw new Error('Unknown team in fixture feed');
    const played = completed.filter(f => f.team_h === id || f.team_a === id).sort((a,b) => Date.parse(a.kickoff_time)-Date.parse(b.kickoff_time));
    const games = played.map(f => { const home = f.team_h === id; const scored = home ? f.team_h_score : f.team_a_score; const conceded = home ? f.team_a_score : f.team_h_score; return {date:f.kickoff_time, opponent:byId.get(home ? f.team_a : f.team_h)?.name, home, scored, conceded, result:scored>conceded?'W':scored<conceded?'L':'D'}; });
    return {id, name:t.name, short:t.short_name, code:t.code, played:games.length, points:games.reduce((s,g)=>s+(g.result==='W'?3:g.result==='D'?1:0),0), goalsFor:games.reduce((s,g)=>s+g.scored,0), goalsAgainst:games.reduce((s,g)=>s+g.conceded,0), recent:games.slice(-5)};
  };
  return fixtures.filter(f => !f.finished && !f.started && (!f.kickoff_time || Date.parse(f.kickoff_time)>now)).map(f=>({id:f.id, gameweek:f.event, kickoff:f.kickoff_time, provisional:!!f.provisional_start_time, home:team(f.team_h), away:team(f.team_a)})).sort((a,b)=>(a.kickoff?Date.parse(a.kickoff):Infinity)-(b.kickoff?Date.parse(b.kickoff):Infinity)||a.id-b.id);
}

export function predictionQuestions() {
  const criteria = {};
  for (let h=0;h<=6;h++) for(let a=0;a<=6;a++) criteria[`${h}_${a}`]=`Home team scores ${h}, away team scores ${a}, after 90 minutes plus stoppage time.`;
  return {outcome:{type:'choice',instructions:'Predict the full-time result of this upcoming Premier League match using the supplied recent results and season statistics. Account for home advantage and uncertainty. Do not assume any unavailable injuries or lineups.',criteria:{home:'Home team wins',draw:'Match ends in a draw',away:'Away team wins'}},score:{type:'choice',instructions:'Select the most plausible exact full-time score from the available 0–6 goals per team options, using supplied form and goal statistics. This is a speculative forecast.',criteria}};
}

export function parsePrediction(body) {
  const {outcome,score}=body.answers ?? {};
  const p=outcome?.probabilities;
  if (!['home','draw','away'].includes(outcome?.choice) || !p || !['home','draw','away'].every(k=>Number.isFinite(p[k])&&p[k]>=0&&p[k]<=1) || Math.abs(p.home+p.draw+p.away-1)>0.02 || !/^[0-6]_[0-6]$/.test(score?.choice)) throw new Error('Jev returned an incomplete prediction. Please retry.');
  return {outcome:outcome.choice,probabilities:{home:p.home,draw:p.draw,away:p.away},score:score.choice.split('_').map(Number),generatedAt:new Date().toISOString(),model:'typesafe-ai/jev'};
}

export function teamRef(teams, id) {
  const t = teams.find(x => x.id === id);
  return t ? {id:t.id, name:t.name, short:t.short_name, code:t.code} : {id, name:'Unknown', short:'???', code:null};
}

export function matchOutcome(home, away) {
  return home > away ? 'home' : home < away ? 'away' : 'draw';
}

export function evaluatePrediction(prediction, actualHome, actualAway) {
  const actualOutcome = matchOutcome(actualHome, actualAway);
  return {
    actualScore: [actualHome, actualAway],
    actualOutcome,
    correctOutcome: prediction.outcome === actualOutcome,
    correctScore: prediction.score[0] === actualHome && prediction.score[1] === actualAway,
  };
}

export function accuracySummary(results) {
  const resolved = results.length;
  const outcomeCorrect = results.filter(r => r.correctOutcome).length;
  const scoreCorrect = results.filter(r => r.correctScore).length;
  return {
    resolved,
    outcomeCorrect,
    outcomeAccuracy: resolved ? outcomeCorrect / resolved : null,
    scoreCorrect,
    scoreAccuracy: resolved ? scoreCorrect / resolved : null,
  };
}
