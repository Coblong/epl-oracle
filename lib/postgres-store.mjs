import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {accuracySummary, evaluatePrediction, matchOutcome, teamRef} from './football.mjs';
import {fingerprint, inspectSnapshot} from './migration.mjs';
import {recordRetryMigration,runSchemaMigrations} from './schema-migrations.mjs';

export function createPostgresStore(pool, schema = 'epl_oracle') {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('Invalid database schema name.');
  const sql = text => text.replaceAll('epl_oracle.', `"${schema}".`);
  const query = (client, text, values = []) => client.query(sql(text), values);
  const meta = async (client, key) => (await query(client, 'SELECT value FROM epl_oracle.metadata WHERE key=$1', [key])).rows[0]?.value;
  const putMeta = (client, key, value) => query(client, 'INSERT INTO epl_oracle.metadata VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(value)]);
  const retryStatusSql = `CASE WHEN r.run_key LIKE 'weekly:%' AND (
      a.status='failed' OR (a.status='started' AND a.updated_at <= $1::timestamptz - INTERVAL '6 minutes')) THEN
    CASE WHEN $1::timestamptz >= r.scheduled_at + INTERVAL '24 hours'
      OR NOT f.upcoming OR f.data->>'kickoff' IS NULL OR (f.data->>'kickoff')::timestamptz <= $1::timestamptz THEN 'expired'
      WHEN a.attempt_count >= 3 THEN 'exhausted' ELSE a.status END
    ELSE a.status END`;
  async function settle(client, now) {
    await query(client, `INSERT INTO epl_oracle.attempts (run_id,fixture_id,provider,status,attempt_count)
      SELECT s.run_id,s.fixture_id,p.provider,'expired',0 FROM epl_oracle.snapshots s
      JOIN epl_oracle.runs r ON r.id=s.run_id JOIN epl_oracle.fixtures f ON f.id=s.fixture_id
      CROSS JOIN (VALUES ('jev'),('openai')) p(provider)
      WHERE r.run_key LIKE 'weekly:%' AND ($1::timestamptz >= r.scheduled_at + INTERVAL '24 hours'
        OR NOT f.upcoming OR f.data->>'kickoff' IS NULL OR (f.data->>'kickoff')::timestamptz <= $1::timestamptz)
      ON CONFLICT (run_id,fixture_id,provider) DO NOTHING`, [now]);
    await query(client, `UPDATE epl_oracle.attempts a SET status=${retryStatusSql},claim_token=NULL
      FROM epl_oracle.runs r,epl_oracle.fixtures f WHERE r.id=a.run_id AND f.id=a.fixture_id
        AND a.status IN ('failed','started') AND a.status <> (${retryStatusSql})`, [now]);
  }
  const ready = async client => { if (!(await meta(client, 'migration'))?.verified) throw new Error('Neon has not passed migration validation. Keep PERSISTENCE_BACKEND=blob until import succeeds.'); };
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
  async function attempt(client, {runId, fixtureId, provider = 'jev', status, error = null, claimToken = null, attemptAt = new Date().toISOString()}) {
    await query(client, `INSERT INTO epl_oracle.attempts (run_id,fixture_id,provider,status,error,attempt_count,updated_at)
      VALUES ($1,$2,$3,$4,$5,1,$7::timestamptz)
      ON CONFLICT (run_id,fixture_id,provider) DO UPDATE SET status=CASE
        WHEN EXCLUDED.status='failed' AND epl_oracle.attempts.attempt_count >= 3 THEN 'exhausted'
        ELSE EXCLUDED.status END,error=EXCLUDED.error,updated_at=EXCLUDED.updated_at,
        next_attempt_at=CASE WHEN EXCLUDED.status='failed'
          THEN GREATEST(epl_oracle.attempts.next_attempt_at,EXCLUDED.updated_at + INTERVAL '15 minutes')
          ELSE epl_oracle.attempts.next_attempt_at END
      WHERE epl_oracle.attempts.status NOT IN ('succeeded','exhausted','expired')
        AND (epl_oracle.attempts.claim_token IS NULL OR epl_oracle.attempts.claim_token=$6)`,
    [runId, fixtureId, provider, status, error, claimToken, attemptAt]);
  }
  async function insertPrediction(client, {runId, fixtureId, provider = 'jev', matchSignature = null, prediction, claimToken = null, attemptAt}) {
    await query(client, `INSERT INTO epl_oracle.predictions (run_id,fixture_id,provider,match_signature,generated_at,data) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (run_id,fixture_id,provider) DO NOTHING`, [runId, fixtureId, provider, matchSignature, prediction.generatedAt, JSON.stringify(prediction)]);
    await attempt(client, {runId, fixtureId, provider, status: 'succeeded',claimToken,attemptAt});
    return (await query(client, 'SELECT id FROM epl_oracle.predictions WHERE run_id=$1 AND fixture_id=$2 AND provider=$3', [runId, fixtureId, provider])).rows[0].id;
  }
  async function predictions(client, upcomingOnly = true) {
    const rows = (await query(client, `SELECT DISTINCT ON (p.fixture_id) p.fixture_id,p.match_signature,p.data
      FROM epl_oracle.predictions p JOIN epl_oracle.fixtures f ON f.id=p.fixture_id
      WHERE p.provider='jev' ${upcomingOnly ? 'AND f.upcoming' : ''} ORDER BY p.fixture_id,p.generated_at DESC,p.id DESC`)).rows;
    return Object.fromEntries(rows.map(r => [r.fixture_id, {matchSignature: r.match_signature, prediction: r.data}]));
  }
  async function results(client) { return (await query(client, 'SELECT data FROM epl_oracle.results ORDER BY fixture_id')).rows.map(r => r.data); }
  async function resultsPage(client, {page = 1, pageSize = 20} = {}) {
    const currentPage = Math.max(1, Math.trunc(Number(page) || 1));
    const size = Math.min(20, Math.max(1, Math.trunc(Number(pageSize) || 20)));
    const offset = (currentPage - 1) * size;
    const refreshedAt=(await meta(client,'fixtures'))?.updatedAt ?? new Date().toISOString();
    const seasonYear=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric'}).format(new Date(refreshedAt)))
      -(Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',month:'numeric'}).format(new Date(refreshedAt)))<8?1:0);
    const seasonStart=`${seasonYear}-08-01T00:00:00+01:00`;
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
      LEFT JOIN epl_oracle.predictions p ON p.id=rp.prediction_id
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
      result.missingProviders = ['jev','openai'].filter(provider => !result.forecasts[provider]);
      if (result.forecasts.jev) Object.assign(result,result.forecasts.jev);
    }
    return {results:items,summary:accuracySummary(await results(client)),page:currentPage,pageSize:size,total,hasMore:offset + items.length < total};
  }
  async function providerPredictions(client) {
    const rows = (await query(client, `SELECT DISTINCT ON (p.fixture_id,p.provider) p.fixture_id,p.provider,p.run_id,r.run_key,p.match_signature,p.data
      FROM epl_oracle.predictions p JOIN epl_oracle.fixtures f ON f.id=p.fixture_id JOIN epl_oracle.runs r ON r.id=p.run_id
      WHERE f.upcoming ORDER BY p.fixture_id,p.provider,p.generated_at DESC,p.id DESC`)).rows;
    const byFixture = {};
    for (const r of rows) (byFixture[r.fixture_id] ??= {})[r.provider] = {runId:r.run_id,runKey:r.run_key,matchSignature:r.match_signature, prediction:r.data};
    return byFixture;
  }
  async function forecastAttempts(client) {
    const rows = (await query(client, `SELECT DISTINCT ON (a.fixture_id,a.provider) a.fixture_id,a.provider,a.run_id,r.run_key,${retryStatusSql} AS status,a.attempt_count,a.next_attempt_at
      FROM epl_oracle.attempts a JOIN epl_oracle.runs r ON r.id=a.run_id
      JOIN epl_oracle.fixtures f ON f.id=a.fixture_id WHERE f.upcoming
      ORDER BY a.fixture_id,a.provider,r.scheduled_at DESC,a.updated_at DESC,r.id DESC`, [new Date().toISOString()])).rows;
    const byFixture = {};
    for (const row of rows) (byFixture[row.fixture_id] ??= {})[row.provider] = {runId:row.run_id,runKey:row.run_key,status:row.status,attemptCount:row.attempt_count,nextAttemptAt:row.status==='failed' ? row.next_attempt_at : null};
    return byFixture;
  }
  async function fixtures(client) {
    const metadata = await meta(client, 'fixtures');
    if (!metadata) return null;
    const rows = (await query(client, 'SELECT data FROM epl_oracle.fixtures WHERE upcoming ORDER BY id')).rows;
    const matches = rows.map(r => r.data).sort((a,b) => (a.kickoff ? Date.parse(a.kickoff) : Infinity) - (b.kickoff ? Date.parse(b.kickoff) : Infinity) || a.id-b.id);
    return {...metadata, matches};
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
    async getPredictions() { await ready(pool); return predictions(pool); },
    async getProviderPredictions() { await ready(pool); return providerPredictions(pool); },
    async getResults() { await ready(pool); return results(pool); },
    async getResultsPage(options) { return transaction(client => resultsPage(client,options)); },
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
          RETURNING run_id`,
        [entry.runId, entry.fixtureId, entry.provider ?? 'jev', entry.claimUntil, entry.attemptAt ?? new Date().toISOString(), entry.claimToken ?? null]);
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
        attempts: (await query(client, 'SELECT fixture_id AS "fixtureId",provider,status,error,attempt_count AS "attemptCount",next_attempt_at AS "nextAttemptAt" FROM epl_oracle.attempts WHERE run_id=$1 ORDER BY fixture_id,provider', [runId])).rows,
      }));
    },
    refreshFixtures({matches, raw, teams, source, updatedAt}) {
      return transaction(async client => {
        const previous = await meta(client, 'fixtures');
        if (previous && Date.parse(previous.updatedAt) > Date.parse(updatedAt)) return {resolved: 0, skipped: 'older refresh'};
        let resolved = 0, corrected = 0;
        for (const match of matches) {
          const old = (await query(client, 'SELECT data FROM epl_oracle.fixtures WHERE id=$1', [match.id])).rows[0]?.data;
          const fixtureStatus = !match.kickoff && old?.kickoff ? 'awaiting_rescheduling'
            : match.fixtureStatus ?? (!match.kickoff ? 'awaiting_date' : null);
          const data = fixtureStatus ? {...match,fixtureStatus} : match;
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
            const data = {...(previousData ?? {id:fixture.id,gameweek:fixture.event,kickoff:fixture.kickoff_time,home,away}),fixtureStatus:'cancelled'};
            await query(client, `INSERT INTO epl_oracle.fixtures (id,data,upcoming) VALUES ($1,$2,false)
              ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,upcoming=false`, [fixture.id,JSON.stringify(data)]);
            await query(client, `INSERT INTO epl_oracle.fixture_results
                (fixture_id,status,gameweek,kickoff,home,away,actual_home_score,actual_away_score,updated_at)
              VALUES ($1,'cancelled',$2,$3,$4,$5,NULL,NULL,$6::timestamptz)
              ON CONFLICT (fixture_id) DO UPDATE SET status='cancelled',gameweek=EXCLUDED.gameweek,kickoff=EXCLUDED.kickoff,
                home=EXCLUDED.home,away=EXCLUDED.away,actual_home_score=NULL,actual_away_score=NULL,updated_at=EXCLUDED.updated_at`,
            [fixture.id,fixture.event,fixture.kickoff_time,JSON.stringify(home),JSON.stringify(away),updatedAt]);
            await query(client, `UPDATE epl_oracle.result_predictions SET eligible=false,correct_outcome=NULL,correct_score=NULL,evaluated_at=$2::timestamptz WHERE fixture_id=$1`, [fixture.id,updatedAt]);
            await query(client, `UPDATE epl_oracle.results SET data=data || '{"cancelled":true,"eligible":false}'::jsonb WHERE fixture_id=$1`, [fixture.id]);
            continue;
          }
          if (fixture.finished && Number.isInteger(fixture.team_h_score) && Number.isInteger(fixture.team_a_score)) {
            const homeJson=JSON.stringify(home),awayJson=JSON.stringify(away);
            const data={id:fixture.id,gameweek:fixture.event,kickoff:fixture.kickoff_time,home,away,fixtureStatus:'completed'};
            await query(client, `INSERT INTO epl_oracle.fixtures (id,data,upcoming) VALUES ($1,$2,false)
              ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,upcoming=false`, [fixture.id,JSON.stringify(data)]);
            const previousResult=(await query(client, `SELECT status,actual_home_score,actual_away_score FROM epl_oracle.fixture_results WHERE fixture_id=$1`, [fixture.id])).rows[0];
            await query(client, `INSERT INTO epl_oracle.fixture_results
                (fixture_id,status,gameweek,kickoff,home,away,actual_home_score,actual_away_score,updated_at)
              VALUES ($1,'completed',$2,$3,$4,$5,$6,$7,$8::timestamptz)
              ON CONFLICT (fixture_id) DO UPDATE SET status='completed',gameweek=EXCLUDED.gameweek,kickoff=EXCLUDED.kickoff,
                home=EXCLUDED.home,away=EXCLUDED.away,actual_home_score=EXCLUDED.actual_home_score,
                actual_away_score=EXCLUDED.actual_away_score,updated_at=EXCLUDED.updated_at`,
            [fixture.id,fixture.event,fixture.kickoff_time,homeJson,awayJson,fixture.team_h_score,fixture.team_a_score,updatedAt]);
            await query(client, `UPDATE epl_oracle.results SET data=data-'cancelled' WHERE fixture_id=$1`, [fixture.id]);
            for (const provider of ['jev','openai']) {
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
          } else if (fixture.started) {
            const data={...(previousData ?? {id:fixture.id,gameweek:fixture.event,kickoff:fixture.kickoff_time,home,away}),
              gameweek:fixture.event,kickoff:fixture.kickoff_time,fixtureStatus:'in_progress'};
            await query(client, `INSERT INTO epl_oracle.fixtures (id,data,upcoming) VALUES ($1,$2,false)
              ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,upcoming=false`, [fixture.id,JSON.stringify(data)]);
          }
        }
        await putMeta(client, 'fixtures', {source, updatedAt});
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
          await insertPrediction(client, {runId:r.id, fixtureId, matchSignature:entry.matchSignature, prediction:entry.prediction});
        }
        for (const result of completed) {
          const r = await run(client, `legacy-result:${result.id}`, result.prediction.generatedAt);
          await snapshot(client, r.id, result.id, null);
          const predictionId = await insertPrediction(client, {runId:r.id, fixtureId:result.id, prediction:result.prediction});
          await query(client, 'INSERT INTO epl_oracle.results VALUES ($1,$2,$3)', [result.id, predictionId, JSON.stringify(result)]);
        }
        await putMeta(client, 'fixtures', {source:fixtureDoc.source, updatedAt:fixtureDoc.updatedAt});
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
