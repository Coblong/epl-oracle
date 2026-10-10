import test from 'node:test';
import assert from 'node:assert/strict';
import {assertStaticRootOutput,deploymentMigrationTarget} from '../lib/deployment-migrations.mjs';

test('migration builds require the project-root static output directory',()=>{
  assert.doesNotThrow(()=>assertStaticRootOutput({outputDirectory:'.'}));
  assert.throws(()=>assertStaticRootOutput({outputDirectory:'public'}),/project root/);
  assert.throws(()=>assertStaticRootOutput({}),/project root/);
});

test('production migrations require Neon credentials and the explicit production schema',()=>{
  const valid={VERCEL_ENV:'production',PERSISTENCE_BACKEND:'neon',DATABASE_URL:'test-only-connection',DATABASE_SCHEMA:'epl_oracle'};
  assert.deepEqual(deploymentMigrationTarget(valid),{schema:'epl_oracle'});
  for(const key of ['PERSISTENCE_BACKEND','DATABASE_URL','DATABASE_SCHEMA']){
    const invalid={...valid};delete invalid[key];assert.throws(()=>deploymentMigrationTarget(invalid));
  }
  assert.throws(()=>deploymentMigrationTarget({...valid,DATABASE_SCHEMA:'epl_oracle_review'}));
});

test('preview migrations require an explicit isolated schema and never default to production',()=>{
  const valid={VERCEL_ENV:'preview',PERSISTENCE_BACKEND:'neon',DATABASE_URL:'test-only-connection',DATABASE_SCHEMA:'epl_oracle_review'};
  assert.deepEqual(deploymentMigrationTarget(valid),{schema:'epl_oracle_review'});
  assert.throws(()=>deploymentMigrationTarget({...valid,DATABASE_SCHEMA:'epl_oracle'}),/isolated/);
  const missing={...valid};delete missing.DATABASE_URL;
  assert.match(deploymentMigrationTarget(missing).skipped,/Static build continues/);
  const partial={...valid};delete partial.DATABASE_SCHEMA;
  assert.match(deploymentMigrationTarget(partial).skipped,/isolated DATABASE_SCHEMA/);
  assert.throws(()=>deploymentMigrationTarget({...valid,DATABASE_SCHEMA:'invalid-name'}),/valid/);
});

test('local and non-Neon preview builds skip migrations with a clear explanation',()=>{
  assert.match(deploymentMigrationTarget({VERCEL_ENV:'development'}).skipped,/outside Vercel/);
  assert.match(deploymentMigrationTarget({VERCEL_ENV:'preview',PERSISTENCE_BACKEND:'blob'}).skipped,/Static build continues/);
});
