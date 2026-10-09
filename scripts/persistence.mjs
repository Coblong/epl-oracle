import {readFile, writeFile} from 'node:fs/promises';
import {captureSnapshot, inspectSnapshot, fingerprint} from '../lib/migration.mjs';
import {writeJSON} from '../lib/blob-store.mjs';
import {createMigrationReader} from '../lib/blob-migration.mjs';
import {databasePool, closeDatabase} from '../lib/store.mjs';
import {createPostgresStore} from '../lib/postgres-store.mjs';

const [command, ...args] = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
async function save(path, data) {
  if (!path || path.startsWith('--')) throw new Error('Supply --output with a new snapshot filename.');
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', {mode:0o600, flag:'wx'});
}
async function source() {
  const path = value('--input');
  if (!args.includes('--input') || !path || path.startsWith('--')) throw new Error('Supply --input with the saved Blob snapshot filename.');
  const data = JSON.parse(await readFile(path, 'utf8'));
  inspectSnapshot(data);
  return data;
}
function normalize(snapshot) {
  return {...snapshot, fixtures:{...snapshot.fixtures, matches:[...snapshot.fixtures.matches].sort((a,b)=>a.id-b.id)}, results:[...snapshot.results].sort((a,b)=>a.id-b.id)};
}

try {
  if (command === 'export-blob') {
    const snapshot = await captureSnapshot(createMigrationReader());
    await save(value('--output'), snapshot);
    console.log(JSON.stringify({saved:true, ...inspectSnapshot(snapshot)}, null, 2));
  } else if (command === 'restore-blob') {
    const snapshot = await source();
    if (!args.includes('--apply')) console.log(JSON.stringify({dryRun:true, ...inspectSnapshot(snapshot)}, null, 2));
    else {
      // Both cron jobs must be paused throughout restoration. Neon history is
      // untouched; preserve the original Blob export separately for rollback.
      await writeJSON('data/fixtures.json', snapshot.fixtures);
      await writeJSON('data/predictions.json', snapshot.predictions);
      await writeJSON('data/results.json', snapshot.results);
      if (fingerprint(normalize(await captureSnapshot(createMigrationReader()))) !== fingerprint(normalize(snapshot))) throw new Error('Blob restoration verification failed. Keep jobs paused and retry restoration.');
      console.log(JSON.stringify({restored:true, ...inspectSnapshot(snapshot)}, null, 2));
    }
  } else if (['setup','import','verify','export-neon'].includes(command)) {
    if (command === 'import' && !args.includes('--apply')) {
      console.log(JSON.stringify({dryRun:true, ...inspectSnapshot(await source())}, null, 2));
    } else {
      const store = createPostgresStore(databasePool(), process.env.DATABASE_SCHEMA || 'epl_oracle');
      if (command === 'setup') { await store.initialize(); console.log('Database schema initialized. Backend has not been changed.'); }
      if (command === 'import') console.log(JSON.stringify(await store.importSnapshot(await source()), null, 2));
      if (command === 'verify' || command === 'export-neon') {
        const {fixtures, predictions} = await store.getFixtureView();
        const snapshot = {fixtures, predictions, results:await store.getResults()};
        if (command === 'export-neon') {
          await save(value('--output'), snapshot);
          console.log(JSON.stringify({saved:true, ...inspectSnapshot(snapshot)}, null, 2));
        } else {
          const baseline = await source();
          if (fingerprint(normalize(snapshot)) !== fingerprint(normalize(baseline))) throw new Error('Neon differs from the migration snapshot. Do not cut over until this is investigated.');
          console.log(JSON.stringify({verified:true, ...inspectSnapshot(baseline)}, null, 2));
        }
      }
    }
  } else throw new Error('Use setup, export-blob --output FILE, import --input FILE [--apply], verify --input FILE, export-neon --output FILE, or restore-blob --input FILE [--apply].');
} catch (error) {
  // Drivers may include connection details in error objects; do not log them.
  const safe = /^(Invalid|Duplicate|Fixture|Source|Blob |Migration |Neon |A different|Supply |Use |Database |DATABASE_URL|PERSISTENCE_BACKEND)/.test(error.message);
  console.error(safe ? error.message : 'Persistence operation failed. Check configuration and connectivity; secret values omitted.');
  process.exitCode = 1;
} finally { await closeDatabase(); }
