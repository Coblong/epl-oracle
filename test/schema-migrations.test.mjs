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
  assert.equal((await migrationHistory(pool,schema)).length,1);
});

dbtest('overlapping deployment migrations apply a pending version exactly once',async()=>{
  const migrations=[...await schemaMigrations(),{version:'002-probe',mode:'automatic',sql:'CREATE TABLE epl_oracle.migration_probe (id integer PRIMARY KEY);'}];
  const reports=await Promise.all([runSchemaMigrations(pool,schema,{migrations}),runSchemaMigrations(pool,schema,{migrations})]);
  assert.equal(reports.flatMap(report=>report.applied).length,1);
  assert.equal((await migrationHistory(pool,schema)).length,2);
  assert.deepEqual(await runSchemaMigrations(pool,schema,{migrations}),{applied:[],registered:[]});
});

dbtest('a failed pending migration rolls back its SQL and ledger entry together',async()=>{
  const baseline=await schemaMigrations();
  const migration={version:'002-failing-probe',mode:'automatic',sql:'CREATE TABLE epl_oracle.rollback_probe (id integer); SELECT missing_column FROM epl_oracle.rollback_probe;'};
  await assert.rejects(runSchemaMigrations(pool,schema,{migrations:[...baseline,migration]}),/missing_column/);
  assert.equal((await migrationHistory(pool,schema)).length,1);
  const corrected={...migration,sql:'CREATE TABLE epl_oracle.rollback_probe (id integer);'};
  assert.deepEqual((await runSchemaMigrations(pool,schema,{migrations:[...baseline,corrected]})).applied,['002-failing-probe']);
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
  assert.deepEqual(await runSchemaMigrations(pool,schema),{applied:[],registered:['001-retry-status']});
  assert.equal((await migrationHistory(pool,schema)).length,1);
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
  assert.equal((await migrationHistory(pool,schema)).length,1);
});
