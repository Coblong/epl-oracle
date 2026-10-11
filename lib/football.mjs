export function isCompletedFixture(fixture, now = Date.now()) {
  const kickoff = Date.parse(fixture.kickoff_time);
  return fixture.cancelled !== true
    && (fixture.finished === true || fixture.finished_provisional === true)
    && Number.isFinite(kickoff) && kickoff < now
    && Number.isInteger(fixture.team_h_score) && Number.isInteger(fixture.team_a_score);
}

export function validateTeamCatalog(teams, fixtures) {
  if (!Array.isArray(teams)) throw new Error('Invalid Premier League team catalog');
  const byId = new Map();
  for (const team of teams) {
    if (!Number.isSafeInteger(team?.id) || team.id < 1 || typeof team.name!=='string' || !team.name.trim()
      || typeof team.short_name!=='string' || !team.short_name.trim() || !Number.isSafeInteger(team.code) || team.code < 1
      || byId.has(team.id)) throw new Error('Invalid Premier League team catalog');
    byId.set(team.id,team);
  }
  for (const fixture of fixtures) {
    if (!Number.isSafeInteger(fixture.team_h) || !byId.has(fixture.team_h)
      || !Number.isSafeInteger(fixture.team_a) || !byId.has(fixture.team_a)) {
      throw new Error(`Fixture ${fixture.id} references an unknown team`);
    }
  }
  return [...byId.values()];
}

export function buildFixtures(fixtures, teams, now = Date.now()) {
  const byId = new Map(teams.map(t => [t.id, t]));
  const completed = fixtures.filter(f => isCompletedFixture(f,now));
  const team = id => {
    const t = byId.get(id);
    if (!t) throw new Error('Unknown team in fixture feed');
    const played = completed.filter(f => f.team_h === id || f.team_a === id).sort((a,b) => Date.parse(a.kickoff_time)-Date.parse(b.kickoff_time));
    const games = played.map(f => { const home = f.team_h === id; const scored = home ? f.team_h_score : f.team_a_score; const conceded = home ? f.team_a_score : f.team_h_score; return {date:f.kickoff_time, opponent:byId.get(home ? f.team_a : f.team_h)?.name, home, scored, conceded, result:scored>conceded?'W':scored<conceded?'L':'D'}; });
    return {id, name:t.name, short:t.short_name, code:t.code, played:games.length, points:games.reduce((s,g)=>s+(g.result==='W'?3:g.result==='D'?1:0),0), goalsFor:games.reduce((s,g)=>s+g.scored,0), goalsAgainst:games.reduce((s,g)=>s+g.conceded,0), recent:games.slice(-5)};
  };
  return fixtures.filter(f => f.cancelled!==true && !isCompletedFixture(f,now) && !f.finished && !f.finished_provisional && !f.started && (!f.kickoff_time || Date.parse(f.kickoff_time)>now)).map(f=>({id:f.id, gameweek:f.event, kickoff:f.kickoff_time, provisional:!!f.provisional_start_time, fixtureStatus:f.kickoff_time?undefined:'awaiting_date', home:team(f.team_h), away:team(f.team_a)})).sort((a,b)=>(a.kickoff?Date.parse(a.kickoff):Infinity)-(b.kickoff?Date.parse(b.kickoff):Infinity)||a.id-b.id);
}

export function predictionEvidence(match) {
  return {competition:'English Premier League', match,
    context:'Statistics are current-season completed league results only. No live injury, lineup or betting data is provided. Model probabilities are unvalidated football estimates.'};
}

export function predictionQuestions() {
  const criteria = {};
  for (let h=0;h<=6;h++) for(let a=0;a<=6;a++) criteria[`${h}_${a}`]=`Home team scores ${h}, away team scores ${a}, after 90 minutes plus stoppage time.`;
  return {score:{type:'choice',instructions:'Estimate the probabilities of the exact full-time scorelines for this upcoming Premier League match using the supplied recent results and season statistics. Account for home advantage and uncertainty. Do not assume unavailable injuries or lineups. Allocate probabilities across all available 0–6 goals per team options. These are speculative forecasts. The application will sum these probabilities to select the most likely match result, then select the most likely score within that result.',criteria}};
}

const OUTCOME_ORDER = ['home','draw','away'];
const TIE_EPSILON = 1e-12;

export function deriveScorePrediction(distribution) {
  const allowed = Object.keys(predictionQuestions().score.criteria);
  if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)
    || Object.keys(distribution).length !== allowed.length
    || !allowed.every(key => Object.hasOwn(distribution,key) && Number.isFinite(distribution[key])
      && distribution[key] >= 0 && distribution[key] <= 1)) {
    throw new Error('The model returned an incomplete or invalid score distribution. Please retry.');
  }
  const total = allowed.reduce((sum,key) => sum + distribution[key],0);
  if (Math.abs(total - 1) > 0.02) throw new Error('The model returned an invalid score probability total. Please retry.');
  const scoreProbabilities = Object.fromEntries(allowed.map(key => [key,distribution[key]/total]));
  const probabilities = {home:0,draw:0,away:0};
  const scorelines = allowed.map(key => {
    const score = key.split('_').map(Number), outcome = matchOutcome(...score);
    probabilities[outcome] += scoreProbabilities[key];
    return {score,outcome,probability:scoreProbabilities[key]};
  });
  const bestScore = outcome => {
    const candidates = scorelines.filter(line => line.outcome === outcome);
    const highest = Math.max(...candidates.map(line => line.probability));
    // Score ties prefer fewer total goals, then lower home goals, then away goals.
    return candidates.filter(line => highest-line.probability <= TIE_EPSILON).sort((a,b) =>
      a.score[0]+a.score[1]-b.score[0]-b.score[1] || a.score[0]-b.score[0] || a.score[1]-b.score[1])[0];
  };
  const highestOutcome = Math.max(...Object.values(probabilities));
  let contenders = OUTCOME_ORDER.filter(outcome => highestOutcome-probabilities[outcome] <= TIE_EPSILON).map(bestScore);
  const highestScore = Math.max(...contenders.map(line => line.probability));
  contenders = contenders.filter(line => highestScore-line.probability <= TIE_EPSILON);
  // Result ties prefer the strongest individual score, then fewer total goals,
  // then the fixed home/draw/away order. Avoid floating-point noise as a tie-breaker.
  contenders.sort((a,b) => a.score[0]+a.score[1]-b.score[0]-b.score[1]
    || OUTCOME_ORDER.indexOf(a.outcome)-OUTCOME_ORDER.indexOf(b.outcome));
  const chosen = contenders[0];
  return {outcome:chosen.outcome,score:chosen.score,probabilities,scoreProbabilities,
    scoreProbabilityTotal:total,method:'score-distribution-result-first-v1'};
}

export function parsePrediction(body) {
  const answers = body?.answers, score = answers?.score;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)
    || Object.keys(answers).length !== 1 || !Object.hasOwn(answers,'score')
    || typeof score?.choice !== 'string' || !/^[0-6]_[0-6]$/.test(score.choice)
    || score.type !== undefined && score.type !== 'choice') {
    throw new Error('The model returned an incomplete score prediction. Please retry.');
  }
  return {...deriveScorePrediction(score.probabilities),providerScoreChoice:score.choice,
    generatedAt:new Date().toISOString(),model:'typesafe-ai/jev'};
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
  const eligible = results.filter(r => r.eligible !== false && r.cancelled !== true);
  const resolved = eligible.length;
  const outcomeCorrect = eligible.filter(r => r.correctOutcome).length;
  const scoreCorrect = eligible.filter(r => r.correctScore).length;
  return {
    resolved,
    outcomeCorrect,
    outcomeAccuracy: resolved ? outcomeCorrect / resolved : null,
    scoreCorrect,
    scoreAccuracy: resolved ? scoreCorrect / resolved : null,
  };
}
