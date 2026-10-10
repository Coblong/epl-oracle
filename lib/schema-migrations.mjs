import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const checksum = sql => createHash('sha256').update(sql).digest('hex');
const validateSchema = schema => {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('Migration requires a valid explicit database schema.');
};
const queryFor = (client,schema) => (sql,values=[])=>client.query(sql.replaceAll('epl_oracle.',`"${schema}".`),values);

export async function schemaMigrations() {
  return [{version:'001-retry-status',mode:'manual',marker:'retry_schema_v1',
    instructions:'Run upgrade-retries with writers paused after the six-minute drain before deploying.',
    sql:await readFile(new URL('../db/upgrade-retries.sql',import.meta.url),'utf8')},
  {version:'002-results',mode:'automatic',sql:await readFile(new URL('../db/results.sql',import.meta.url),'utf8')}];
}

async function ensureLedger(query) {
  await query(`CREATE TABLE IF NOT EXISTS epl_oracle.schema_migrations (
    version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
}
async function requireManualCheckpoint(query,migration,schema) {
  const instructions=migration.instructions??'Complete the approved operator upgrade before deploying.';
  const relation=(await query('SELECT to_regclass($1) IS NOT NULL AS available',[`${schema}.metadata`])).rows[0]?.available;
  const marker=relation && (await query('SELECT value FROM epl_oracle.metadata WHERE key=$1',[migration.marker])).rows[0]?.value;
  if(!marker?.verified)throw new Error(`Migration ${migration.version} requires a manual upgrade. ${instructions}`);
}
async function register(query,migration) {
  const previous=(await query('SELECT checksum FROM epl_oracle.schema_migrations WHERE version=$1',[migration.version])).rows[0];
  const digest=checksum(migration.sql);
  if(previous){
    if(previous.checksum!==digest)throw new Error(`Migration ${migration.version} checksum changed. Restore the applied file and add a new migration.`);
    return false;
  }
  await query('INSERT INTO epl_oracle.schema_migrations(version,checksum) VALUES ($1,$2)',[migration.version,digest]);
  return true;
}

// Called inside initialize/upgrade's existing transaction and persistence lock.
export async function recordRetryMigration(client,schema) {
  validateSchema(schema);
  const query=queryFor(client,schema);
  await ensureLedger(query);
  const migration=(await schemaMigrations())[0];
  await requireManualCheckpoint(query,migration,schema);
  return register(query,migration);
}

export async function migrationHistory(pool,schema) {
  validateSchema(schema);
  return (await queryFor(pool,schema)('SELECT version,checksum FROM epl_oracle.schema_migrations ORDER BY version')).rows;
}

export async function runSchemaMigrations(pool,schema,{migrations}={}) {
  validateSchema(schema);
  migrations??=await schemaMigrations();
  const client=await pool.connect();
  const query=queryFor(client,schema);
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${schema}:persistence`]);
    await ensureLedger(query);
    const history=new Map((await query('SELECT version,checksum FROM epl_oracle.schema_migrations')).rows.map(row=>[row.version,row.checksum]));
    const report={applied:[],registered:[]};
    for(const migration of migrations){
      if(migration.mode==='manual')await requireManualCheckpoint(query,migration,schema);
      if(history.has(migration.version)){
        if(history.get(migration.version)!==checksum(migration.sql))throw new Error(`Migration ${migration.version} checksum changed. Restore the applied file and add a new migration.`);
        continue;
      }
      if(migration.mode==='automatic'){
        await query(migration.sql);
        await register(query,migration);
        report.applied.push(migration.version);
      } else {
        if(migration.mode!=='manual')throw new Error(`Migration ${migration.version} has an unsupported mode.`);
        await register(query,migration);
        report.registered.push(migration.version);
      }
    }
    await client.query('COMMIT');
    return report;
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}
