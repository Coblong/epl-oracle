import test from 'node:test';
import assert from 'node:assert/strict';
import {createBlobStore} from '../lib/blob-store.mjs';
import {predictFixtures} from '../lib/prediction-job.mjs';
import {getStore} from '../lib/store.mjs';

test('one prediction job accumulates all writes despite a stale public document', async () => {
  const before = {10:{matchSignature:'old', prediction:{outcome:'draw'}}};
  const writes = [];
  let reads = 0;
  const store = createBlobStore({
    read:async () => { reads++; return structuredClone(before); },
    write:async (path, data) => { assert.equal(path, 'data/predictions.json'); writes.push(structuredClone(data)); },
  });
  const targets = [{id:11}, {id:12}, {id:13}];
  const stats = await predictFixtures(store, targets, async match => ({outcome:'home', fixtureId:match.id}), async () => {});
  assert.deepEqual(stats, {updated:3, failed:0});
  assert.equal(reads, 1);
  assert.deepEqual(writes.map(data => Object.keys(data)), [['10','11'], ['10','11','12'], ['10','11','12','13']]);
  assert.equal(writes[2][11].prediction.fixtureId, 11);
  assert.deepEqual(before, {10:{matchSignature:'old', prediction:{outcome:'draw'}}});
});

test('a failed Blob write does not contaminate later successful predictions', async () => {
  let saved;
  const store = createBlobStore({read:async () => ({}), write:async (path, data) => {
    if (data[11]) throw new Error('Write failed');
    saved = structuredClone(data);
  }});
  await assert.rejects(store.savePrediction({fixtureId:11, matchSignature:'a', prediction:{}}), /Write failed/);
  await store.savePrediction({fixtureId:12, matchSignature:'b', prediction:{}});
  assert.deepEqual(Object.keys(saved), ['12']);
});

test('Blob requests receive separate accumulation state in a warm process', () => {
  const previous = process.env.PERSISTENCE_BACKEND;
  try {
    process.env.PERSISTENCE_BACKEND = 'blob';
    assert.notEqual(getStore(), getStore());
  } finally {
    if (previous === undefined) delete process.env.PERSISTENCE_BACKEND;
    else process.env.PERSISTENCE_BACKEND = previous;
  }
});
