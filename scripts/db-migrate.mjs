import {readFile} from 'node:fs/promises';
import {databasePool,closeDatabase} from '../lib/store.mjs';
import {assertStaticRootOutput,deploymentMigrationTarget} from '../lib/deployment-migrations.mjs';
import {runSchemaMigrations} from '../lib/schema-migrations.mjs';

async function verifyStaticRootOutputConfig() {
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  assertStaticRootOutput(config);
}

try {
  await verifyStaticRootOutputConfig();
  const target=deploymentMigrationTarget(process.env);
  if(target.skipped) console.log(target.skipped);
  else console.log(JSON.stringify({migrations:await runSchemaMigrations(databasePool(),target.schema)},null,2));
} catch(error) {
  const safe=/^(Database migration build|Migration |Migration production|Migration preview|Preview database)/.test(error.message);
  console.error(safe?error.message:'Database migration failed. Check server configuration and connectivity; secret values omitted.');
  process.exitCode=1;
} finally {
  await closeDatabase();
}
