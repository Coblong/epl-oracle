import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobNotFoundError, BlobPreconditionFailedError} from '@vercel/blob';
import {createMigrationReader} from '../lib/blob-migration.mjs';
import {captureSnapshot} from '../lib/migration.mjs';

const current = {fixtures:{matches:[],source:'Current origin',updatedAt:'2026-10-09T09:00:00Z'}, predictions:{}, results:[]};

function storage() {
  const copies = new Map(), deleted = [], reads = [];
  const source = path => current[path.split('/').at(-1).split('.')[0]];
  const blob = {
    async head(path) { return {url:path, etag:'origin-v2'}; },
    async copy(from, to, options) {
      assert.equal(options.ifMatch, 'origin-v2');
      assert.equal(options.allowOverwrite, false);
      assert.equal(options.addRandomSuffix, false);
      assert.ok(!copies.has(to));
      copies.set(to, JSON.stringify(source(from)));
      return {url:to, etag:'copy-v2'};
    },
    async get(url) {
      reads.push(url);
      // The live public URL consistently serves yesterday's stale cached data.
      const content = copies.get(url) ?? JSON.stringify({...source(url), source:'Yesterday'});
      return {statusCode:200, blob:{etag:copies.has(url) ? 'copy-v2' : 'cached-v1'}, stream:new Response(content).body};
    },
    async del(url) { assert.ok(copies.has(url)); deleted.push(url); copies.delete(url); },
  };
  return {blob, copies, deleted, reads};
}

test('export reads current origin copies despite a consistently stale public cache', async () => {
  const {blob, copies, deleted, reads} = storage();
  const cached = await blob.get('data/fixtures.json');
  assert.equal((await new Response(cached.stream).json()).source, 'Yesterday');
  reads.length = 0;
  assert.deepEqual(await captureSnapshot(createMigrationReader(blob)), current);
  assert.equal(new Set(reads).size, 6);
  assert.ok(reads.every(url => url.startsWith('migration-snapshots/')));
  assert.equal(deleted.length, 6);
  assert.equal(copies.size, 0);
});

test('reader refuses a mismatched download ETag and cleans up its copy', async () => {
  const {blob, copies, deleted} = storage();
  const get = blob.get;
  blob.get = async url => ({...await get(url), blob:{etag:'cached-v1'}});
  await assert.rejects(createMigrationReader(blob)('data/fixtures.json'), /copy verification failed/);
  assert.equal(deleted.length, 1);
  assert.equal(copies.size, 0);
});

test('reader accepts the matching weak CDN validator used for compressed JSON', async () => {
  const {blob} = storage();
  const get = blob.get;
  blob.get = async url => ({...await get(url), blob:{etag:'W/copy-v2'}});
  assert.deepEqual(await createMigrationReader(blob)('data/fixtures.json'), current.fixtures);
});

test('reader rejects source updates during a read and conditional-copy conflicts', async () => {
  const {blob, copies} = storage();
  let calls = 0;
  blob.head = async path => ({url:path, etag:++calls === 1 ? 'origin-v2' : 'origin-v3'});
  await assert.rejects(createMigrationReader(blob)('data/fixtures.json'), /changed during export/);
  assert.equal(copies.size, 0);
  blob.head = async path => ({url:path, etag:'origin-v2'});
  blob.copy = async () => { throw new BlobPreconditionFailedError(); };
  await assert.rejects(createMigrationReader(blob)('data/fixtures.json'), /changed during export/);
});

test('only confirmed missing source documents use the fallback', async () => {
  const {blob} = storage();
  blob.head = async () => { throw new BlobNotFoundError(); };
  assert.deepEqual(await createMigrationReader(blob)('data/results.json', []), []);
  await assert.rejects(captureSnapshot(createMigrationReader(blob)), /missing migration source/);
  blob.head = async () => { throw new Error('Metadata API unavailable'); };
  await assert.rejects(createMigrationReader(blob)('data/results.json', []), /unavailable/);
});

test('reader fails closed on a missing copied object or missing source ETag', async () => {
  const {blob, copies} = storage();
  blob.get = async () => null;
  await assert.rejects(createMigrationReader(blob)('data/fixtures.json'), /copy verification failed/);
  assert.equal(copies.size, 0);
  blob.head = async path => ({url:path});
  await assert.rejects(createMigrationReader(blob)('data/fixtures.json'), /no ETag/);
});

test('reader cleans up on invalid JSON and fails if cleanup fails', async () => {
  const {blob, copies} = storage();
  const get = blob.get;
  blob.get = async url => ({...await get(url), stream:new Response('invalid JSON').body});
  await assert.rejects(createMigrationReader(blob)('data/fixtures.json'), SyntaxError);
  assert.equal(copies.size, 0);
  blob.get = get;
  blob.del = async () => { throw new Error('Cleanup unavailable'); };
  await assert.rejects(createMigrationReader(blob)('data/fixtures.json'), /Cleanup unavailable/);
});
