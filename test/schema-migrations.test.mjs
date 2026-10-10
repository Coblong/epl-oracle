import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPostgresStore} from '../lib/postgres-store.mjs';
import {runSchemaMigrations,migrationHistory,schemaMigrations} from '../lib/schema-migrations.mjs';

const enabled=!!process.env.TEST_DATABASE_URL;
const schema='epl_oracle_migrations_test_'+randomUUID().replaceAll('-','');
let pool,store;
before(()=>{if(enabled){pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});store=createPostgresStore(pool,schema);}});
beforeEach(async()=>{if(enabled){await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await store.initialize();}});
after(async()=>{if(enabled){await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await pool.end();}});
const dbtest=(name,fn)=>test(name,{skip:!enabled},fn);

dbtest('deployment migrations do nothing after the manual retry baseline is registered',async()=>{
  const first=await runSchemaMigrations(pool,schema);
  const second=await runSchemaMigrations(pool,schema);
  assert.deepEqual(first,{applied:[],registered:[]});
  assert.deepEqual(second,first);
  assert.equal((await migrationHistory(pool,schema)).length,2);
});

dbtest('overlapping deployment migrations apply a pending version exactly once',async()=>{
  const migrations=[...await schemaMigrations(),{version:'003-probe',mode:'automatic',sql:'CREATE TABLE epl_oracle.migration_probe (id integer PRIMARY KEY);'}];
  const reports=await Promise.all([runSchemaMigrations(pool,schema,{migrations}),runSchemaMigrations(pool,schema,{migrations})]);
  assert.equal(reports.flatMap(report=>report.applied).length,1);
  assert.equal((await migrationHistory(pool,schema)).length,3);
  assert.deepEqual(await runSchemaMigrations(pool,schema,{migrations}),{applied:[],registered:[]});
});

dbtest('a failed pending migration rolls back its SQL and ledger entry together',async()=>{
  const baseline=await schemaMigrations();
  const migration={version:'003-failing-probe',mode:'automatic',sql:'CREATE TABLE epl_oracle.rollback_probe (id integer); SELECT missing_column FROM epl_oracle.rollback_probe;'};
  await assert.rejects(runSchemaMigrations(pool,schema,{migrations:[...baseline,migration]}),/missing_column/);
  assert.equal((await migrationHistory(pool,schema)).length,2);
  const corrected={...migration,sql:'CREATE TABLE epl_oracle.rollback_probe (id integer);'};
  assert.deepEqual((await runSchemaMigrations(pool,schema,{migrations:[...baseline,corrected]})).applied,['003-failing-probe']);
});

dbtest('changing an already applied migration fails without replacing its checksum',async()=>{
  const before=await migrationHistory(pool,schema);
  const migrations=await schemaMigrations();
  migrations[0].sql+='\n-- changed applied source\n';
  await assert.rejects(runSchemaMigrations(pool,schema,{migrations}),/checksum changed/);
  assert.deepEqual(await migrationHistory(pool,schema),before);
});

dbtest('an older verified retry upgrade is registered without rerunning its SQL',async()=>{
  await pool.query(`DELETE FROM "${schema}".schema_migrations`);
  assert.deepEqual(await runSchemaMigrations(pool,schema),{applied:['002-results'],registered:['001-retry-status']});
  assert.equal((await migrationHistory(pool,schema)).length,2);
});

dbtest('the results migration does not copy legacy history into the new Results view',async()=>{
  const oldFixture={id:10,gameweek:1,kickoff:'2026-09-25T12:00:00Z',home:{id:1,name:'Home'},away:{id:2,name:'Away'}};
  const oldPrediction={outcome:'home',score:[2,1],probabilities:{home:.6,draw:.25,away:.15},generatedAt:'2026-09-20T09:00:00Z',model:'typesafe-ai/jev'};
  const result={...oldFixture,prediction:oldPrediction,actualScore:[2,1],actualOutcome:'home',correctOutcome:true,correctScore:true,evaluatedAt:'2026-09-26T09:00:00Z'};
  const runId='legacy-result-10';
  await pool.query(`DROP TABLE "${schema}".result_predictions CASCADE; DROP TABLE "${schema}".fixture_results CASCADE;
    DELETE FROM "${schema}".schema_migrations WHERE version='002-results';`);
  await pool.query(`INSERT INTO "${schema}".fixtures(id,data,upcoming) VALUES ($1,$2,false)
    ON CONFLICT(id) DO NOTHING`,[10,JSON.stringify(oldFixture)]);
  await pool.query(`INSERT INTO "${schema}".runs(id,run_key,scheduled_at) VALUES ($1,$2,$3)
    ON CONFLICT(id) DO NOTHING`,[runId,'legacy-result:10',oldPrediction.generatedAt]);
  await pool.query(`INSERT INTO "${schema}".snapshots(run_id,fixture_id,input) VALUES ($1,10,NULL)
    ON CONFLICT DO NOTHING`,[runId]);
  const prediction=await pool.query(`INSERT INTO "${schema}".predictions(run_id,fixture_id,provider,generated_at,data)
    VALUES ($1,10,'jev',$2,$3) RETURNING id`,[runId,oldPrediction.generatedAt,JSON.stringify(oldPrediction)]);
  await pool.query(`INSERT INTO "${schema}".results(fixture_id,prediction_id,data) VALUES (10,$1,$2)
    ON CONFLICT(fixture_id) DO NOTHING`,[prediction.rows[0].id,JSON.stringify(result)]);

  assert.deepEqual(await runSchemaMigrations(pool,schema),{applied:['002-results'],registered:[]});
  const legacy=(await pool.query(`SELECT data FROM "${schema}".results WHERE fixture_id=10`)).rows[0].data;
  assert.deepEqual(legacy,result);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".fixture_results`)).rows[0].count,0);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".result_predictions`)).rows[0].count,0);
});

dbtest('deployment refuses the initial retry upgrade until its manual checkpoint exists',async()=>{
  await pool.query(`DELETE FROM "${schema}".schema_migrations;
    DELETE FROM "${schema}".metadata WHERE key='retry_schema_v1'`);
  await assert.rejects(runSchemaMigrations(pool,schema),/writers paused.*six-minute drain/);
  assert.deepEqual(await migrationHistory(pool,schema),[]);
});

dbtest('deployment refuses a missing manual checkpoint even when its ledger entry exists',async()=>{
  await pool.query(`DELETE FROM "${schema}".metadata WHERE key='retry_schema_v1'`);
  await assert.rejects(runSchemaMigrations(pool,schema),/writers paused.*six-minute drain/);
  assert.equal((await migrationHistory(pool,schema)).length,2);
});
