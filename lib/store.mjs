import {Pool} from 'pg';
import {createBlobStore} from './blob-store.mjs';
import {createPostgresStore} from './postgres-store.mjs';

let neon, pool;

export function databasePool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
  pool ??= new Pool({connectionString:process.env.DATABASE_URL, max:3, connectionTimeoutMillis:15000, idleTimeoutMillis:10000, allowExitOnIdle:true});
  return pool;
}

export function getStore() {
  const backend = process.env.PERSISTENCE_BACKEND || 'blob';
  // Blob accumulation belongs to one request, not the warm function process.
  if (backend === 'blob') return createBlobStore();
  if (backend !== 'neon') throw new Error('PERSISTENCE_BACKEND must be blob or neon.');
  neon ??= createPostgresStore(databasePool(), process.env.DATABASE_SCHEMA || 'epl_oracle');
  return neon;
}

export async function closeDatabase() { if (pool) { await pool.end(); pool = undefined; neon = undefined; } }
