import {AGENT_IDS} from '../agents.mjs';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {accuracySummary, evaluatePrediction, isCompletedFixture, matchOutcome, teamRef} from './football.mjs';
import {fingerprint, inspectSnapshot} from './migration.mjs';
import {scoreMatchOScore,summarizeOScoreMatches,summarizeSharedOScoreMatches} from './o-score.mjs';
import {summarizeGameweeks} from '../gameweek-leaderboard.mjs';
import {trackRecordSummaries} from './track-record.mjs';
import {recordRetryMigration,runSchemaMigrations} from './schema-migrations.mjs';

export function createPostgresStore(pool, schema = 'epl_oracle') {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('Invalid database schema name.');
  const sql = text => text.replaceAll('epl_oracle.', `"${schema}".`);
  const query = (client, text, values = []) => client.query(sql(text), values);
  const meta = async (client, key) => (await query(client, 'SELECT value FROM epl_oracle.metadata WHERE key=$1', [key])).rows[0]?.value;
  const putMeta = (client, key, value) => query(client, 'INSERT INTO epl_oracle.metadata VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(value)]);
  const retryStatusSql = `CASE WHEN (r.run_key LIKE 'weekly:%' OR r.run_key LIKE 'competition:%') AND (
      a.status='failed' OR (a.status='started' AND a.updated_at <= $1::timestamptz - INTERVAL '6 minutes')) THEN
    CASE WHEN $1::timestamptz >= r.scheduled_at + INTERVAL '24 hours'
      OR NOT f.upcoming OR f.data->>'kickoff' IS NULL OR (f.data->>'kickoff')::timestamptz <= $1::timestamptz THEN 'expired'
      WHEN a.attempt_count >= 3 THEN 'exhausted' ELSE a.status END
    ELSE a.status END`;
  async function settle(client, now) {
    await query(client, `INSERT INTO epl_oracle.attempts (run_id,fixture_id,provider,status,attempt_count)
      SELECT s.run_id,s.fixture_id,p.provider,'expired',0 FROM epl_oracle.snapshots s
      JOIN epl_oracle.runs r ON r.id=s.run_id JOIN epl_oracle.fixtures f ON f.id=s.fixture_id
      CROSS JOIN unnest($2::text[]) p(provider)
      WHERE (r.run_key LIKE 'weekly:%' OR r.run_key LIKE 'competition:%') AND ($1::timestamptz >= r.scheduled_at + INTERVAL '24 hours'
        OR NOT f.upcoming OR f.data->>'kickoff' IS NULL OR (f.data->>'kickoff')::timestamptz <= $1::timestamptz)
      ON CONFLICT (run_id,fixture_id,provider) DO NOTHING`, [now,AGENT_IDS]);
    await query(client, `UPDATE epl_oracle.attempts a SET status=${retryStatusSql},claim_token=NULL
      FROM epl_oracle.runs r,epl_oracle.fixtures f WHERE r.id=a.run_id AND f.id=a.fixture_id
        AND a.status IN ('failed','started') AND a.status <> (${retryStatusSql})`, [now]);
    await query(client, `UPDATE epl_oracle.attempt_history h SET status=a.status,updated_at=$1::timestamptz
      FROM epl_oracle.attempts a WHERE h.run_id=a.run_id AND h.fixture_id=a.fixture_id AND h.provider=a.provider
        AND h.attempt_number=a.attempt_count AND h.status='started' AND a.status IN ('expired','exhausted')`,[now]);
  }
  const ready = async client => { if (!(await meta(client, 'migration'))?.verified) throw new Error('Neon has not passed migration validation. Keep PERSISTENCE_BACKEND=blob until import succeeds.'); };
  const seasonStartFor = updatedAt => {
    const date=new Date(updatedAt);
    const year=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric'}).format(date))
      -(Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',month:'numeric'}).format(date))<8?1:0);
    return `${year}-08-01T00:00:00+01:00`;
  };
  async function transaction(work, requireReady = true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${schema}:persistence`]);
      if (requireReady) await ready(client);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async function run(client, key, scheduledAt) {
    await query(client, 'INSERT INTO epl_oracle.runs VALUES ($1,$2,$3) ON CONFLICT (run_key) DO NOTHING', [randomUUID(), key, scheduledAt]);
    return (await query(client, 'SELECT id,run_key AS "runKey",scheduled_at AS "scheduledAt" FROM epl_oracle.runs WHERE run_key=$1', [key])).rows[0];
  }
  async function snapshot(client, runId, fixtureId, input) {
    await query(client, 'INSERT INTO epl_oracle.snapshots VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [runId, fixtureId, input === null ? null : JSON.stringify(input)]);
    return (await query(client, 'SELECT input FROM epl_oracle.snapshots WHERE run_id=$1 AND fixture_id=$2', [runId, fixtureId])).rows[0].input;
  }
  async function observeAttempt(client, {runId,fixtureId,provider,attemptNumber,status,metadata=null,attemptAt}) {
    if (!attemptNumber) return;
    if (status==='started') await query(client, `UPDATE epl_oracle.attempt_history SET status='abandoned'
      WHERE run_id=$1 AND fixture_id=$2 AND provider=$3 AND attempt_number<$4 AND status='started'`,
    [runId,fixtureId,provider,attemptNumber]);
    await query(client, `INSERT INTO epl_oracle.attempt_history
      (run_id,fixture_id,provider,attempt_number,status,metadata,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (run_id,fixture_id,provider,attempt_number) DO UPDATE
        SET status=EXCLUDED.status,metadata=EXCLUDED.metadata,updated_at=EXCLUDED.updated_at
        WHERE epl_oracle.attempt_history.status='started'`,
    [runId,fixtureId,provider,attemptNumber,status,metadata===null?null:JSON.stringify(metadata),attemptAt]);
  }
  async function attempt(client, {runId, fixtureId, provider = 'jev', status, error = null, metadata = null, audit = true, claimToken = null, attemptAt = new Date().toISOString()}) {
    const observed = await query(client, `INSERT INTO epl_oracle.attempts (run_id,fixture_id,provider,status,error,attempt_count,updated_at)
      VALUES ($1,$2,$3,$4,$5,1,$7::timestamptz)
      ON CONFLICT (run_id,fixture_id,provider) DO UPDATE SET status=CASE
        WHEN EXCLUDED.status='failed' AND epl_oracle.attempts.attempt_count >= 3 THEN 'exhausted'
        ELSE EXCLUDED.status END,error=EXCLUDED.error,updated_at=EXCLUDED.updated_at,
        next_attempt_at=CASE WHEN EXCLUDED.status='failed'
          THEN GREATEST(epl_oracle.attempts.next_attempt_at,EXCLUDED.updated_at + INTERVAL '15 minutes')
          ELSE epl_oracle.attempts.next_attempt_at END
      WHERE epl_oracle.attempts.status NOT IN ('succeeded','exhausted','expired')
        AND (epl_oracle.attempts.claim_token IS NULL OR epl_oracle.attempts.claim_token=$6) RETURNING attempt_count`,
    [runId, fixtureId, provider, status, error, claimToken, attemptAt]);
    if (audit && observed.rowCount) await observeAttempt(client,{runId,fixtureId,provider,attemptNumber:observed.rows[0].attempt_count,status,metadata,attemptAt});
  }
  async function insertPrediction(client, {runId, fixtureId, provider = 'jev', matchSignature = null, prediction, claimToken = null, attemptAt, audit = true}) {
    await query(client, `INSERT INTO epl_oracle.predictions (run_id,fixture_id,provider,match_signature,generated_at,data) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (run_id,fixture_id,provider) DO NOTHING`, [runId, fixtureId, provider, matchSignature, prediction.generatedAt, JSON.stringify(prediction)]);
    await attempt(client, {runId, fixtureId, provider, status: 'succeeded',claimToken,attemptAt,audit,metadata:{model:prediction.model,usage:prediction.usage??null,cost:prediction.cost??null}});
    return (await query(client, 'SELECT id FROM epl_oracle.predictions WHERE run_id=$1 AND fixture_id=$2 AND provider=$3', [runId, fixtureId, provider])).rows[0].id;
  }
  // Include unresolved matches hidden by earlier releases, without a data migration.
  const visibleFixtureSql = "(f.upcoming OR f.data->>'fixtureStatus' = 'in_progress')";
  async function predictions(client, upcomingOnly = true) {
    const rows = (await query(client, `SELECT DISTINCT ON (p.fixture_id) p.fixture_id,p.match_signature,p.data
      FROM epl_oracle.predictions p JOIN epl_oracle.fixtures f ON f.id=p.fixture_id
      WHERE p.provider='jev' ${upcomingOnly ? `AND ${visibleFixtureSql}` : ''} ORDER BY p.fixture_id,p.generated_at DESC,p.id DESC`)).rows;
    return Object.fromEntries(rows.map(r => [r.fixture_id, {matchSignature: r.match_signature, prediction: r.data}]));
  }
  async function results(client) { return (await query(client, 'SELECT data FROM epl_oracle.results ORDER BY fixture_id')).rows.map(r => r.data); }
  async function gameweekSummaries(client, competitionStartedAt = null) {
    const metadata=await meta(client,'fixtures');
    const seasonStart=seasonStartFor(metadata?.updatedAt??new Date().toISOString());
    const ids=Array.isArray(metadata?.officialFixtureIds)?metadata.officialFixtureIds:null;
    const rows=(await query(client, `SELECT f.id,COALESCE(NULLIF(f.data->>'gameweek','')::int,fr.gameweek) AS gameweek,
        CASE WHEN f.upcoming AND f.data->>'fixtureStatus' IS DISTINCT FROM 'cancelled'
          THEN COALESCE(f.data->>'fixtureStatus','upcoming')
          WHEN f.data->>'fixtureStatus'='cancelled' OR fr.status='cancelled' THEN 'cancelled'
          WHEN fr.status='completed' THEN 'completed'
          ELSE COALESCE(f.data->>'fixtureStatus','upcoming') END AS status,
        fr.actual_home_score,fr.actual_away_score,COALESCE(fr.kickoff,NULLIF(f.data->>'kickoff','')::timestamptz) AS kickoff,
        rp.provider,rp.eligible,p.data AS prediction
      FROM epl_oracle.fixtures f
      LEFT JOIN epl_oracle.fixture_results fr ON fr.fixture_id=f.id
      LEFT JOIN epl_oracle.result_predictions rp ON rp.fixture_id=f.id
      LEFT JOIN epl_oracle.predictions p ON p.id=rp.prediction_id AND p.fixture_id=f.id
        AND p.provider=rp.provider AND p.generated_at<fr.kickoff
      WHERE CASE WHEN $2::bigint[] IS NOT NULL THEN f.id=ANY($2::bigint[])
        ELSE f.upcoming OR COALESCE(fr.kickoff,NULLIF(f.data->>'kickoff','')::timestamptz)>=$1::timestamptz
          OR (fr.kickoff IS NULL AND f.data->>'kickoff' IS NULL AND fr.updated_at>=$1::timestamptz) END
      ORDER BY gameweek,f.id,rp.provider`,[seasonStart,ids])).rows;
    const fixtures=new Map();
    for(const row of rows){
      if(!Number.isInteger(row.gameweek))continue;
      let fixture=fixtures.get(row.id);
      if(!fixture){
        fixture={id:row.id,gameweek:row.gameweek,status:row.status,
          kickoff:row.kickoff,
          actualScore:row.status==='completed'&&Number.isInteger(row.actual_home_score)&&Number.isInteger(row.actual_away_score)
            ?[row.actual_home_score,row.actual_away_score]:null,forecasts:{}};
        fixtures.set(row.id,fixture);
      }
      if(fixture.status==='completed'&&row.provider&&row.eligible&&row.prediction)fixture.forecasts[row.provider]=row.prediction;
    }
    const values=[...fixtures.values()];
    const summaries=summarizeGameweeks(values);
    if(!competitionStartedAt)return summaries;
    const boundary=Date.parse(competitionStartedAt);
    for(const week of summaries){
      const activeFixtures=values.filter(f=>f.gameweek===week.gameweek&&Number.isFinite(Date.parse(f.kickoff))&&Date.parse(f.kickoff)>=boundary);
      const active=summarizeGameweeks(activeFixtures);
      const scoped=active.find(item=>item.gameweek===week.gameweek);
      week.competitionCounts=scoped?.counts??{fixtures:0,completed:0,remaining:0,cancelled:0};
      week.competitionComplete=Boolean(scoped?.complete);
      week.competitionSummaries=scoped?Object.fromEntries(AGENT_IDS.map(agent=>[agent,{
        ...scoped.providerSummaries[agent],...scoped.oScoreSummaries[agent],
        brierScore:scoped.sharedComparison.providerSummaries[agent].brierScore,
        brierSampleCount:scoped.sharedComparison.providerSummaries[agent].brierSampleCount}])):null;
    }
    return summaries;
  }
  async function resultsPage(client, {page = 1, pageSize = 20, competitionStartedAt = null} = {}) {
    const currentPage = Math.max(1, Math.trunc(Number(page) || 1));
    const size = Math.min(20, Math.max(1, Math.trunc(Number(pageSize) || 20)));
    const offset = (currentPage - 1) * size;
    const refreshedAt=(await meta(client,'fixtures'))?.updatedAt ?? new Date().toISOString();
    const seasonStart=seasonStartFor(refreshedAt);
    const total = (await query(client, `SELECT count(*)::int AS total FROM epl_oracle.fixture_results
      WHERE COALESCE(kickoff,updated_at) >= $1::timestamptz`, [seasonStart])).rows[0].total;
    const rows = (await query(client, `WITH selected AS (
        SELECT * FROM epl_oracle.fixture_results WHERE COALESCE(kickoff,updated_at) >= $3::timestamptz
        ORDER BY kickoff DESC NULLS LAST,fixture_id DESC LIMIT $1 OFFSET $2
      )
      SELECT fr.fixture_id,fr.status,fr.gameweek,fr.kickoff,fr.home,fr.away,
        fr.actual_home_score,fr.actual_away_score,rp.provider,rp.prediction_id,rp.eligible,rp.correct_outcome,rp.correct_score,p.data AS prediction
      FROM selected fr
      LEFT JOIN epl_oracle.result_predictions rp ON rp.fixture_id=fr.fixture_id
      LEFT JOIN epl_oracle.predictions p ON p.id=rp.prediction_id AND p.fixture_id=fr.fixture_id
        AND p.provider=rp.provider AND p.generated_at < fr.kickoff
      ORDER BY fr.kickoff DESC NULLS LAST,fr.fixture_id DESC,rp.provider`, [size, offset,seasonStart])).rows;
    const byFixture = new Map();
    for (const row of rows) {
      let result = byFixture.get(row.fixture_id);
      if (!result) {
        result = {id:row.fixture_id,status:row.status,gameweek:row.gameweek,kickoff:row.kickoff,home:row.home,away:row.away,
          actualScore:row.status === 'completed' ? [row.actual_home_score,row.actual_away_score] : null,forecasts:{}};
        if (row.status === 'completed') result.actualOutcome = matchOutcome(row.actual_home_score,row.actual_away_score);
        byFixture.set(row.fixture_id,result);
      }
      if (row.provider && row.prediction && row.eligible) result.forecasts[row.provider] = {
        prediction:row.prediction,correctOutcome:row.correct_outcome,correctScore:row.correct_score,
      };
    }
    const items = [...byFixture.values()];
    for (const result of items) {
      result.missingProviders = AGENT_IDS.filter(provider => !result.forecasts[provider]);
      result.oScores=scoreMatchOScore(Object.fromEntries(Object.entries(result.forecasts)
        .map(([provider,forecast])=>[provider,forecast.prediction])),result.actualScore);
      if (result.forecasts.jev) Object.assign(result,result.forecasts.jev);
    }
    const summaryRows = (await query(client, `SELECT rp.fixture_id AS "fixtureId",rp.provider,p.data AS prediction,
      fr.kickoff,fr.actual_home_score,fr.actual_away_score
      FROM epl_oracle.result_predictions rp
      JOIN epl_oracle.fixture_results fr ON fr.fixture_id=rp.fixture_id
      JOIN epl_oracle.predictions p ON p.id=rp.prediction_id AND p.fixture_id=rp.fixture_id AND p.provider=rp.provider
      WHERE fr.status='completed' AND rp.eligible=true AND p.generated_at < fr.kickoff`)).rows;
    const allTrackRows=summaryRows.map(row => ({...row,
      actualScore:[row.actual_home_score,row.actual_away_score]}));
    const trackRecord = trackRecordSummaries(allTrackRows);
    const oScoreRows=(await query(client, `SELECT fr.fixture_id AS "fixtureId",fr.status,fr.kickoff,
      fr.actual_home_score,fr.actual_away_score,rp.provider,p.data AS prediction
      FROM epl_oracle.fixture_results fr
      LEFT JOIN epl_oracle.result_predictions rp ON rp.fixture_id=fr.fixture_id AND rp.eligible=true
      LEFT JOIN epl_oracle.predictions p ON p.id=rp.prediction_id AND p.fixture_id=fr.fixture_id
        AND p.provider=rp.provider AND p.generated_at < fr.kickoff
      WHERE fr.status='completed' AND fr.kickoff IS NOT NULL`)).rows;
    const oScoreMatches=new Map();
    for(const row of oScoreRows){
      let match=oScoreMatches.get(row.fixtureId);
      if(!match)oScoreMatches.set(row.fixtureId,match={status:row.status,
        actualScore:[row.actual_home_score,row.actual_away_score],forecasts:{}});
      if(AGENT_IDS.includes(row.provider) && row.prediction) match.forecasts[row.provider]=row.prediction;
    }
    const oScoreSummaries=summarizeOScoreMatches([...oScoreMatches.values()]);
    for(const agent of AGENT_IDS) trackRecord.providerSummaries[agent].oScoreDiagnostics={
      scope:'full_history',...oScoreSummaries[agent]};
    trackRecord.sharedComparison.oScoreDiagnostics=summarizeSharedOScoreMatches([...oScoreMatches.values()]);
    let competitionSummaries=null;
    if(competitionStartedAt){
      const boundary=Date.parse(competitionStartedAt);
      const scopedTrack=allTrackRows.filter(row=>Date.parse(row.kickoff)>=boundary);
      const scopedOScore=[...oScoreMatches.entries()].filter(([fixtureId])=>{
        const kickoff=oScoreRows.find(row=>row.fixtureId===fixtureId)?.kickoff;
        return Number.isFinite(Date.parse(kickoff))&&Date.parse(kickoff)>=boundary;
      }).map(([,match])=>match);
      const scopedSummary=trackRecordSummaries(scopedTrack);
      const scopedOScoreSummaries=summarizeOScoreMatches(scopedOScore);
      competitionSummaries=Object.fromEntries(AGENT_IDS.map(agent=>[agent,{
        ...scopedSummary.providerSummaries[agent],...scopedOScoreSummaries[agent],
        brierScore:scopedSummary.sharedComparison.providerSummaries[agent].brierScore,
        brierSampleCount:scopedSummary.sharedComparison.providerSummaries[agent].brierSampleCount}]));
    }
    return {results:items,summary:accuracySummary(await results(client)),...trackRecord,
      ...(competitionSummaries?{competitionSummaries}:{}),gameweeks:await gameweekSummaries(client,competitionStartedAt),page:currentPage,pageSize:size,total,hasMore:offset + items.length < total};
  }
  async function providerPredictions(client) {
    const rows = (await query(client, `SELECT DISTINCT ON (p.fixture_id,p.provider) p.fixture_id,p.provider,p.run_id,r.run_key,p.match_signature,p.data
      FROM epl_oracle.predictions p JOIN epl_oracle.fixtures f ON f.id=p.fixture_id JOIN epl_oracle.runs r ON r.id=p.run_id
      WHERE ${visibleFixtureSql} ORDER BY p.fixture_id,p.provider,p.generated_at DESC,p.id DESC`)).rows;
    const byFixture = {};
    for (const r of rows) (byFixture[r.fixture_id] ??= {})[r.provider] = {runId:r.run_id,runKey:r.run_key,matchSignature:r.match_signature, prediction:r.data};
    return byFixture;
  }
  async function forecastAttempts(client) {
    const rows = (await query(client, `SELECT DISTINCT ON (a.fixture_id,a.provider) a.fixture_id,a.provider,a.run_id,r.run_key,${retryStatusSql} AS status,a.attempt_count,a.next_attempt_at
      FROM epl_oracle.attempts a JOIN epl_oracle.runs r ON r.id=a.run_id
      JOIN epl_oracle.fixtures f ON f.id=a.fixture_id WHERE ${visibleFixtureSql}
      ORDER BY a.fixture_id,a.provider,r.scheduled_at DESC,a.updated_at DESC,r.id DESC`, [new Date().toISOString()])).rows;
    const byFixture = {};
    for (const row of rows) (byFixture[row.fixture_id] ??= {})[row.provider] = {runId:row.run_id,runKey:row.run_key,status:row.status,attemptCount:row.attempt_count,nextAttemptAt:row.status==='failed' ? row.next_attempt_at : null};
    return byFixture;
  }
  async function fixtures(client) {
    const metadata = await meta(client, 'fixtures');
    if (!metadata) return null;
    const rows = (await query(client, `SELECT f.data FROM epl_oracle.fixtures f WHERE ${visibleFixtureSql} ORDER BY f.id`)).rows;
    const matches = rows.map(r => r.data).sort((a,b) => (a.kickoff ? Date.parse(a.kickoff) : Infinity) - (b.kickoff ? Date.parse(b.kickoff) : Infinity) || a.id-b.id);
    return {...metadata, matches};
  }
  async function teamCatalog(client) {
    const cached=await meta(client,'team_catalog');
    if (Array.isArray(cached?.teams)) return cached.teams;
    const rows=(await query(client, `SELECT data FROM epl_oracle.fixtures
      WHERE data->'home' IS NOT NULL AND data->'away' IS NOT NULL
      ORDER BY data->>'kickoff' DESC NULLS LAST,id DESC`)).rows;
    const teams=new Map();
    for (const {data} of rows) for (const ref of [data.home,data.away]) {
      const id=Number(ref?.id),code=Number(ref?.code);
      if (!Number.isSafeInteger(id) || id < 1 || typeof ref?.name!=='string' || !ref.name.trim()
        || typeof ref?.short!=='string' || !ref.short.trim() || !Number.isSafeInteger(code) || code < 1
        || teams.has(id)) continue;
      teams.set(id,{id,name:ref.name,short_name:ref.short,code});
    }
    return [...teams.values()];
  }
  return {
    async initialize() {
      const ddl = (await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8')).replaceAll('epl_oracle', schema);
      const upgrade = (await readFile(new URL('../db/upgrade-retries.sql', import.meta.url), 'utf8')).replaceAll('epl_oracle.', `"${schema}".`);
      await transaction(async client => {await client.query(ddl);await client.query(upgrade);await recordRetryMigration(client,schema);}, false);
      await runSchemaMigrations(pool,schema);
    },
    async upgradeRetries() {
      const upgrade = (await readFile(new URL('../db/upgrade-retries.sql', import.meta.url), 'utf8')).replaceAll('epl_oracle.', `"${schema}".`);
      await transaction(async client => {await client.query(upgrade);await recordRetryMigration(client,schema);});
      return {verified:true};
    },
    async getFixtures() { await ready(pool); return fixtures(pool); },
    async getTeamCatalog() { return transaction(client => teamCatalog(client)); },
    async getPredictions() { await ready(pool); return predictions(pool); },
    async getProviderPredictions() { await ready(pool); return providerPredictions(pool); },
    async getResults() { await ready(pool); return results(pool); },
    async getResultsPage(options) { return transaction(client => resultsPage(client,options)); },
    async getCompetition() { return transaction(client => meta(client,'competition')); },
    async activateCompetition(startedAt = new Date().toISOString()) {
      return transaction(async client => {
        const current=await meta(client,'competition');
        if(current?.active && current.startedAt)return current;
        const value={active:true,startedAt:new Date(startedAt).toISOString(),
          includedFixtureBoundary:{type:'kickoff_at_or_after',timestamp:new Date(startedAt).toISOString()}};
        await putMeta(client,'competition',value);
        return meta(client,'competition');
      });
    },
    async getFixtureView() {
      // One locked transaction gives API readers a consistent fixture/prediction view.
      return transaction(async client => ({fixtures: await fixtures(client), predictions: await predictions(client), providerPredictions:await providerPredictions(client), forecastAttempts:await forecastAttempts(client)}));
    },
    beginRun(runKey, scheduledAt = new Date().toISOString()) { return transaction(client => run(client, runKey, scheduledAt)); },
    saveSnapshot(runId, fixtureId, input) { return transaction(client => snapshot(client, runId, fixtureId, input)); },
    claimAttempt(entry) {
      if (!entry.claimUntil) return Promise.resolve(false);
      return transaction(async client => {
        const result = await query(client, `INSERT INTO epl_oracle.attempts (run_id,fixture_id,provider,status,attempt_count,next_attempt_at,claim_token,updated_at)
          SELECT $1,$2,$3,'started',1,$5::timestamptz + INTERVAL '15 minutes',$6,$5::timestamptz
          WHERE $5::timestamptz < $4::timestamptz AND EXISTS (
            SELECT 1 FROM epl_oracle.fixtures WHERE id=$2 AND upcoming AND (data->>'kickoff')::timestamptz > $5::timestamptz)
          ON CONFLICT (run_id,fixture_id,provider) DO UPDATE
          SET status='started',error=NULL,updated_at=$5::timestamptz,attempt_count=epl_oracle.attempts.attempt_count+1,
            next_attempt_at=$5::timestamptz + INTERVAL '15 minutes',claim_token=$6
          WHERE $5::timestamptz < $4::timestamptz AND epl_oracle.attempts.attempt_count < 3
            AND EXISTS (SELECT 1 FROM epl_oracle.fixtures WHERE id=$2 AND upcoming AND (data->>'kickoff')::timestamptz > $5::timestamptz)
            AND $5::timestamptz >= epl_oracle.attempts.next_attempt_at AND (
              epl_oracle.attempts.status='failed'
              OR (epl_oracle.attempts.status='started' AND epl_oracle.attempts.updated_at <= $5::timestamptz - INTERVAL '6 minutes')
          )
          RETURNING run_id,attempt_count`,
        [entry.runId, entry.fixtureId, entry.provider ?? 'jev', entry.claimUntil, entry.attemptAt ?? new Date().toISOString(), entry.claimToken ?? null]);
        if(result.rowCount) await observeAttempt(client,{...entry,provider:entry.provider??'jev',attemptNumber:result.rows[0].attempt_count,status:'started',attemptAt:entry.attemptAt??new Date().toISOString()});
        return result.rowCount === 1;
      });
    },
    recordAttempt(entry) { return transaction(client => attempt(client, entry)); },
    settleAttempts(now = new Date().toISOString()) { return transaction(async client => {await settle(client,now);}); },
    savePrediction(entry) {
      return transaction(async client => {
        if (entry.claimToken) {
          const owned = (await query(client, `SELECT 1 FROM epl_oracle.attempts
            WHERE run_id=$1 AND fixture_id=$2 AND provider=$3 AND claim_token=$4 AND status='started'`,
          [entry.runId,entry.fixtureId,entry.provider ?? 'jev',entry.claimToken])).rowCount;
          if (!owned) return false;
        }
        const fixture = (await query(client, 'SELECT upcoming,data FROM epl_oracle.fixtures WHERE id=$1', [entry.fixtureId])).rows[0];
        // An API call runs outside the transaction. Do not revive a forecast after
        // a fixture refresh has finished or changed the fixture it was based on.
        if (!fixture?.upcoming || JSON.stringify(fixture.data) !== entry.matchSignature && fingerprint(fixture.data) !== fingerprint(JSON.parse(entry.matchSignature))) return false;
        if (Date.parse(fixture.data.kickoff) <= Date.parse(entry.completedAt ?? new Date().toISOString())) return false;
        await insertPrediction(client, entry);
        return true;
      });
    },
    getRun(runId) {
      return transaction(async client => ({
        run: (await query(client, 'SELECT id,run_key AS "runKey",scheduled_at AS "scheduledAt" FROM epl_oracle.runs WHERE id=$1', [runId])).rows[0] ?? null,
        snapshots: (await query(client, 'SELECT fixture_id AS "fixtureId",input FROM epl_oracle.snapshots WHERE run_id=$1 ORDER BY fixture_id', [runId])).rows,
        predictions: (await query(client, 'SELECT fixture_id AS "fixtureId",provider,data FROM epl_oracle.predictions WHERE run_id=$1 ORDER BY fixture_id,provider', [runId])).rows,
        attemptHistory:(await query(client, 'SELECT fixture_id AS "fixtureId",provider,attempt_number AS "attemptNumber",status,metadata,updated_at AS "updatedAt" FROM epl_oracle.attempt_history WHERE run_id=$1 ORDER BY fixture_id,provider,attempt_number',[runId])).rows,
        attempts: (await query(client, 'SELECT fixture_id AS "fixtureId",provider,status,error,attempt_count AS "attemptCount",next_attempt_at AS "nextAttemptAt" FROM epl_oracle.attempts WHERE run_id=$1 ORDER BY fixture_id,provider', [runId])).rows,
      }));
    },
    refreshFixtures({matches, raw, teams, source, updatedAt, verifiedTeamCatalog = true, teamCatalogUpdatedAt = updatedAt}) {
      return transaction(async client => {
        const previous = await meta(client, 'fixtures');
        if (previous && Date.parse(previous.updatedAt) > Date.parse(updatedAt)) return {resolved: 0, skipped: 'older refresh'};
        let resolved = 0, corrected = 0;
        for (const match of matches) {
          const old = (await query(client, 'SELECT data FROM epl_oracle.fixtures WHERE id=$1', [match.id])).rows[0]?.data;
          const fixtureStatus = !match.kickoff && old?.kickoff ? 'awaiting_rescheduling'
            : match.fixtureStatus ?? (!match.kickoff ? 'awaiting_date' : null);
          const data = {...match,gameweek:match.gameweek??old?.gameweek??null};
          if(fixtureStatus)data.fixtureStatus=fixtureStatus;
          await query(client, `INSERT INTO epl_oracle.fixtures (id,data,upcoming) VALUES ($1,$2,true)
            ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,upcoming=true`, [match.id,JSON.stringify(data)]);
        }
        const seen = new Set(raw.map(f => f.id));
        const storedUpcoming = (await query(client, 'SELECT id,data FROM epl_oracle.fixtures WHERE upcoming')).rows;
        if (raw.length) for (const row of storedUpcoming) {
          if (seen.has(row.id)) continue;
          await query(client, `UPDATE epl_oracle.fixtures SET data=$2 WHERE id=$1`, [row.id,JSON.stringify({...row.data,kickoff:null,fixtureStatus:'awaiting_update'})]);
        }
        for (const fixture of raw) {
          const home = teamRef(teams,fixture.team_h), away = teamRef(teams,fixture.team_a);
          const previousData = (await query(client, 'SELECT data FROM epl_oracle.fixtures WHERE id=$1', [fixture.id])).rows[0]?.data;
          if (fixture.cancelled === true) {
            const gameweek=fixture.event??previousData?.gameweek??null;
            const data = {...(previousData ?? {id:fixture.id,kickoff:fixture.kickoff_time,home,away}),gameweek,fixtureStatus:'cancelled'};
            await query(client, `INSERT INTO epl_oracle.fixtures (id,data,upcoming) VALUES ($1,$2,false)
              ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,upcoming=false`, [fixture.id,JSON.stringify(data)]);
            await query(client, `INSERT INTO epl_oracle.fixture_results
                (fixture_id,status,gameweek,kickoff,home,away,actual_home_score,actual_away_score,updated_at)
              VALUES ($1,'cancelled',$2,$3,$4,$5,NULL,NULL,$6::timestamptz)
              ON CONFLICT (fixture_id) DO UPDATE SET status='cancelled',gameweek=EXCLUDED.gameweek,kickoff=EXCLUDED.kickoff,
                home=EXCLUDED.home,away=EXCLUDED.away,actual_home_score=NULL,actual_away_score=NULL,updated_at=EXCLUDED.updated_at`,
            [fixture.id,gameweek,fixture.kickoff_time,JSON.stringify(home),JSON.stringify(away),updatedAt]);
            await query(client, `UPDATE epl_oracle.result_predictions SET eligible=false,correct_outcome=NULL,correct_score=NULL,evaluated_at=$2::timestamptz WHERE fixture_id=$1`, [fixture.id,updatedAt]);
            await query(client, `UPDATE epl_oracle.results SET data=data || '{"cancelled":true,"eligible":false}'::jsonb WHERE fixture_id=$1`, [fixture.id]);
            continue;
          }
          if (isCompletedFixture(fixture,Date.parse(updatedAt))) {
            const homeJson=JSON.stringify(home),awayJson=JSON.stringify(away);
            const gameweek=fixture.event??previousData?.gameweek??null;
            const data={id:fixture.id,gameweek,kickoff:fixture.kickoff_time,home,away,fixtureStatus:'completed'};
            await query(client, `INSERT INTO epl_oracle.fixtures (id,data,upcoming) VALUES ($1,$2,false)
              ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,upcoming=false`, [fixture.id,JSON.stringify(data)]);
            const previousResult=(await query(client, `SELECT status,actual_home_score,actual_away_score FROM epl_oracle.fixture_results WHERE fixture_id=$1`, [fixture.id])).rows[0];
            await query(client, `INSERT INTO epl_oracle.fixture_results
                (fixture_id,status,gameweek,kickoff,home,away,actual_home_score,actual_away_score,updated_at)
              VALUES ($1,'completed',$2,$3,$4,$5,$6,$7,$8::timestamptz)
              ON CONFLICT (fixture_id) DO UPDATE SET status='completed',gameweek=EXCLUDED.gameweek,kickoff=EXCLUDED.kickoff,
                home=EXCLUDED.home,away=EXCLUDED.away,actual_home_score=EXCLUDED.actual_home_score,
                actual_away_score=EXCLUDED.actual_away_score,updated_at=EXCLUDED.updated_at`,
            [fixture.id,gameweek,fixture.kickoff_time,homeJson,awayJson,fixture.team_h_score,fixture.team_a_score,updatedAt]);
            await query(client, `UPDATE epl_oracle.results SET data=data-'cancelled' WHERE fixture_id=$1`, [fixture.id]);
            for (const provider of AGENT_IDS) {
              const prediction = fixture.kickoff_time ? (await query(client, `SELECT id,data FROM epl_oracle.predictions
                WHERE fixture_id=$1 AND provider=$2 AND generated_at < $3::timestamptz
                ORDER BY generated_at DESC,id DESC LIMIT 1`, [fixture.id,provider,fixture.kickoff_time])).rows[0] : null;
              if (!prediction) {
                await query(client, `UPDATE epl_oracle.result_predictions SET eligible=false,correct_outcome=NULL,correct_score=NULL,evaluated_at=$2::timestamptz
                  WHERE fixture_id=$1 AND provider=$3`, [fixture.id,updatedAt,provider]);
                if (provider === 'jev') await query(client, `UPDATE epl_oracle.results SET data=data || '{"eligible":false}'::jsonb WHERE fixture_id=$1`, [fixture.id]);
                continue;
              }
              const evaluated = evaluatePrediction(prediction.data,fixture.team_h_score,fixture.team_a_score);
              await query(client, `INSERT INTO epl_oracle.result_predictions
                  (fixture_id,provider,prediction_id,eligible,correct_outcome,correct_score,evaluated_at)
                VALUES ($1,$2,$3,true,$4,$5,$6::timestamptz)
                ON CONFLICT (fixture_id,provider) DO UPDATE SET prediction_id=EXCLUDED.prediction_id,eligible=true,
                  correct_outcome=EXCLUDED.correct_outcome,correct_score=EXCLUDED.correct_score,evaluated_at=EXCLUDED.evaluated_at`,
              [fixture.id,provider,prediction.id,evaluated.correctOutcome,evaluated.correctScore,updatedAt]);
              if (provider === 'jev') {
                const result={id:fixture.id,gameweek:fixture.event,kickoff:fixture.kickoff_time,home,away,prediction:prediction.data,
                  ...evaluated,evaluatedAt:updatedAt,eligible:true};
                await query(client, `INSERT INTO epl_oracle.results (fixture_id,prediction_id,data) VALUES ($1,$2,$3)
                  ON CONFLICT (fixture_id) DO UPDATE SET prediction_id=EXCLUDED.prediction_id,data=EXCLUDED.data`,
                [fixture.id,prediction.id,JSON.stringify(result)]);
              }
            }
            if (!previousResult) resolved++;
            else if (previousResult.status !== 'completed' || previousResult.actual_home_score !== fixture.team_h_score || previousResult.actual_away_score !== fixture.team_a_score) corrected++;
          } else if (fixture.started || fixture.finished || fixture.finished_provisional
            || fixture.kickoff_time && Date.parse(fixture.kickoff_time) <= Date.parse(updatedAt)) {
            // Keep unresolved matches visible until a complete result is stored.
            // Kickoff checks in forecast scheduling and persistence still prevent late predictions.
            const gameweek=fixture.event??previousData?.gameweek??null;
            const data={...(previousData ?? {id:fixture.id,kickoff:fixture.kickoff_time,
              home:{...home,recent:[]},away:{...away,recent:[]}}),
              gameweek,kickoff:fixture.kickoff_time,fixtureStatus:'awaiting_result'};
            await query(client, `INSERT INTO epl_oracle.fixtures (id,data,upcoming) VALUES ($1,$2,true)
              ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,upcoming=true`, [fixture.id,JSON.stringify(data)]);
          }
        }
        if (verifiedTeamCatalog) await putMeta(client,'team_catalog',{teams,source,updatedAt:teamCatalogUpdatedAt});
        const seasonStart=seasonStartFor(updatedAt);
        const previousIds=previous&&seasonStartFor(previous.updatedAt)===seasonStart&&Array.isArray(previous.officialFixtureIds)
          ?previous.officialFixtureIds:[];
        await putMeta(client, 'fixtures', {source, updatedAt,
          officialFixtureIds:[...new Set([...previousIds,...raw.map(fixture=>fixture.id),...matches.map(match=>match.id)])]});
        await settle(client,new Date().toISOString());
        return {resolved,corrected};
      });
    },
    async importSnapshot(sourceSnapshot) {
      const expected = inspectSnapshot(sourceSnapshot);
      return transaction(async client => {
        const imported = await meta(client, 'migration');
        if (imported) {
          if (imported.digest !== expected.digest) throw new Error('A different snapshot was already imported. Refusing to overwrite Neon data.');
          return {...imported, repeated: true};
        }
        const occupied = (await query(client, 'SELECT EXISTS(SELECT 1 FROM epl_oracle.fixtures) OR EXISTS(SELECT 1 FROM epl_oracle.runs) AS occupied')).rows[0].occupied;
        if (occupied) throw new Error('Migration requires an empty destination.');
        const {fixtures: fixtureDoc, predictions: active, results: completed} = sourceSnapshot;
        for (const f of [...fixtureDoc.matches, ...completed]) await query(client, 'INSERT INTO epl_oracle.fixtures VALUES ($1,$2,$3)', [f.id, JSON.stringify(f), fixtureDoc.matches.some(m => m.id === f.id)]);
        for (const [key, entry] of Object.entries(active)) {
          const fixtureId = Number(key);
          const r = await run(client, `legacy-active:${fixtureId}`, entry.prediction.generatedAt);
          // A stored signature contains the original match evidence; otherwise
          // retain null rather than inventing unavailable source input.
          let input = null;
          try { input = JSON.parse(entry.matchSignature); } catch {}
          await snapshot(client, r.id, fixtureId, input);
          await insertPrediction(client, {runId:r.id, fixtureId, matchSignature:entry.matchSignature, prediction:entry.prediction,audit:false});
        }
        for (const result of completed) {
          const r = await run(client, `legacy-result:${result.id}`, result.prediction.generatedAt);
          await snapshot(client, r.id, result.id, null);
          const predictionId = await insertPrediction(client, {runId:r.id, fixtureId:result.id, prediction:result.prediction,audit:false});
          await query(client, 'INSERT INTO epl_oracle.results VALUES ($1,$2,$3)', [result.id, predictionId, JSON.stringify(result)]);
        }
        const seasonStart=seasonStartFor(fixtureDoc.updatedAt);
        const currentFixtureIds=new Set(fixtureDoc.matches.map(fixture=>fixture.id));
        for(const fixture of completed){
          const date=fixture.kickoff??fixture.evaluatedAt;
          if(date&&Date.parse(date)>=Date.parse(seasonStart))currentFixtureIds.add(fixture.id);
        }
        await putMeta(client, 'fixtures', {source:fixtureDoc.source, updatedAt:fixtureDoc.updatedAt,
          officialFixtureIds:[...currentFixtureIds]});
        const counts = (await query(client, `SELECT (SELECT count(*)::int FROM epl_oracle.fixtures) AS fixtures,
          (SELECT count(*)::int FROM epl_oracle.fixtures WHERE upcoming) AS upcoming,
          (SELECT count(*)::int FROM epl_oracle.predictions) AS "predictionVersions",
          (SELECT count(*)::int FROM epl_oracle.results) AS results`)).rows[0];
        const actual = {...counts, activePredictions:Object.keys(await predictions(client)).length, summary:accuracySummary(await results(client))};
        const {digest, ...totals} = expected;
        if (fingerprint(actual) !== fingerprint(totals)) throw new Error('Migration counts or accuracy totals failed validation. All imported records have been rolled back.');
        // Verify full payloads too, so matching counts cannot hide changed data.
        if (fingerprint(await predictions(client)) !== fingerprint(active) || fingerprint(await results(client)) !== fingerprint([...completed].sort((a,b) => a.id-b.id))) throw new Error('Migration payload validation failed. All imported records have been rolled back.');
        const report = {...expected, verified:true, importedAt:new Date().toISOString()};
        await putMeta(client, 'migration', report);
        return report;
      }, false);
    },
    async migrationReport() { return meta(pool, 'migration'); },
  };
}
