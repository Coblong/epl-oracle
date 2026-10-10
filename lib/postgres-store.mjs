import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {accuracySummary, evaluatePrediction, teamRef} from './football.mjs';
import {fingerprint, inspectSnapshot} from './migration.mjs';
import {recordRetryMigration} from './schema-migrations.mjs';

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
  async function providerPredictions(client) {
    const rows = (await query(client, `SELECT DISTINCT ON (p.fixture_id,p.provider) p.fixture_id,p.provider,p.run_id,p.match_signature,p.data
      FROM epl_oracle.predictions p JOIN epl_oracle.fixtures f ON f.id=p.fixture_id
      WHERE f.upcoming ORDER BY p.fixture_id,p.provider,p.generated_at DESC,p.id DESC`)).rows;
    const byFixture = {};
    for (const r of rows) (byFixture[r.fixture_id] ??= {})[r.provider] = {runId:r.run_id,matchSignature:r.match_signature, prediction:r.data};
    return byFixture;
  }
  async function forecastAttempts(client) {
    const rows = (await query(client, `SELECT DISTINCT ON (a.fixture_id,a.provider) a.fixture_id,a.provider,a.run_id,${retryStatusSql} AS status,a.attempt_count,a.next_attempt_at
      FROM epl_oracle.attempts a JOIN epl_oracle.runs r ON r.id=a.run_id
      JOIN epl_oracle.fixtures f ON f.id=a.fixture_id WHERE f.upcoming
      ORDER BY a.fixture_id,a.provider,r.scheduled_at DESC,a.updated_at DESC,r.id DESC`, [new Date().toISOString()])).rows;
    const byFixture = {};
    for (const row of rows) (byFixture[row.fixture_id] ??= {})[row.provider] = {runId:row.run_id,status:row.status,attemptCount:row.attempt_count,nextAttemptAt:row.status==='failed' ? row.next_attempt_at : null};
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
        const latest = await predictions(client);
        const feed = new Map(raw.map(f => [f.id, f]));
        let resolved = 0;
        for (const [key, entry] of Object.entries(latest)) {
          const f = feed.get(Number(key));
          if (!f?.finished || !Number.isInteger(f.team_h_score) || !Number.isInteger(f.team_a_score)) continue;
          const p = (await query(client, `SELECT id FROM epl_oracle.predictions WHERE fixture_id=$1 AND provider='jev' ORDER BY generated_at DESC,id DESC LIMIT 1`, [f.id])).rows[0];
          const result = {id: f.id, gameweek: f.event, kickoff: f.kickoff_time, home: teamRef(teams, f.team_h), away: teamRef(teams, f.team_a), prediction: entry.prediction,
            ...evaluatePrediction(entry.prediction, f.team_h_score, f.team_a_score), evaluatedAt: updatedAt};
          const saved = await query(client, 'INSERT INTO epl_oracle.results VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [f.id, p.id, JSON.stringify(result)]);
          resolved += saved.rowCount;
        }
        await query(client, 'UPDATE epl_oracle.fixtures SET upcoming=false WHERE upcoming');
        for (const match of matches) await query(client, 'INSERT INTO epl_oracle.fixtures VALUES ($1,$2,true) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,upcoming=true', [match.id, JSON.stringify(match)]);
        await putMeta(client, 'fixtures', {source, updatedAt});
        await settle(client,new Date().toISOString());
        return {resolved};
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
