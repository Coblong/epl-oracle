import test from 'node:test';
import assert from 'node:assert/strict';
import {captureSnapshot, inspectSnapshot} from '../lib/migration.mjs';

const empty = {fixtures:{matches:[],source:'Official Fantasy Premier League',updatedAt:'2026-10-01T09:00:00Z'},predictions:{},results:[]};
test('migration export rejects a changing source rather than accepting mixed versions', async () => {
  let read = 0;
  await assert.rejects(captureSnapshot(async (path, fallback) => path === 'data/fixtures.json' ? {...empty.fixtures,source:String(++read)} : fallback), /changed during export/);
});
test('migration export accepts two identical snapshots and preserves empty history', async () => {
  assert.deepEqual(await captureSnapshot(async (path) => empty[path.split('/')[1].split('.')[0]]),empty);
  assert.equal(inspectSnapshot(empty).summary.resolved,0);
});
test('migration rejects missing fixture documents and duplicate fixtures', () => {
  assert.throws(()=>inspectSnapshot({...empty,fixtures:null}),/missing migration source/);
  const f={id:1,home:{id:1},away:{id:2}};
  assert.throws(()=>inspectSnapshot({...empty,fixtures:{...empty.fixtures,matches:[f,f]}}),/Duplicate/);
});
