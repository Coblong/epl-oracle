import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eligibleWeeklyFixtures, generateWeeklyPredictions, weeklyRunContext} from '../lib/weekly-predictions.mjs';

test('weekly run starts at 09:00 London in winter and summer and expires at Thursday 09:00', () => {
  assert.equal(weeklyRunContext('2026-01-07T08:59:59Z'), null);
  const winter = weeklyRunContext('2026-01-07T09:00:00Z');
  assert.equal(winter.scheduledAt.toISOString(), '2026-01-07T09:00:00.000Z');
  assert.equal(weeklyRunContext('2026-01-08T08:59:59Z').key, winter.key);
  assert.equal(weeklyRunContext('2026-01-08T09:00:00Z'), null);

  assert.equal(weeklyRunContext('2026-07-08T07:59:59Z'), null);
  const summer = weeklyRunContext('2026-07-08T08:00:00Z');
  assert.equal(summer.scheduledAt.toISOString(), '2026-07-08T08:00:00.000Z');
  assert.equal(weeklyRunContext('2026-07-09T07:59:59Z').key, summer.key);
  assert.equal(weeklyRunContext('2026-07-09T08:00:00Z'), null);
});

test('weekly fixture selection uses the scheduled ten-day half-open interval and excludes undated or started fixtures', () => {
  const context = weeklyRunContext('2026-01-07T09:00:00Z');
  const now = '2026-01-07T09:00:00Z';
  const included = {id: 1, kickoff: '2026-01-07T09:01:00Z'};
  const fixtures = [
    included,
    {id: 2, kickoff: '2026-01-17T09:00:00Z'},
    {id: 3, kickoff: null},
    {id: 4, kickoff: '2026-01-07T09:00:00Z'},
  ];
  assert.deepEqual(eligibleWeeklyFixtures(fixtures, now, context), [included]);
});

function fakeStore(matches, updatedAt, snapshots = []) {
  const calls = [];
  const run = {id: 'run-1'};
  return {
    calls,
    async getFixtures() { return {matches, updatedAt}; },
    async beginRun(key, scheduledAt) { calls.push(['run', key, scheduledAt]); return run; },
    async getRun() { return {snapshots}; },
    async saveSnapshot(runId, fixtureId, input) { calls.push(['snapshot', fixtureId]); return input; },
    async claimAttempt({provider}) { calls.push(['claim', provider]); return true; },
    async savePrediction(entry) { calls.push(['save', entry.provider, entry.completedAt]); return true; },
    async recordAttempt(entry) { calls.push(['attempt', entry.provider, entry.status]); },
  };
}

test('an empty eligible window makes no run or provider calls', async () => {
  let providerCalls = 0;
  const store = fakeStore([{id: 1, kickoff: null}], '2026-01-07T08:00:00Z');
  const result = await generateWeeklyPredictions(store, {jev: async () => { providerCalls++; }}, '2026-01-07T09:00:00Z');
  assert.deepEqual(result, {targeted: 0, updated: 0, failed: 0});
  assert.equal(providerCalls, 0);
  assert.deepEqual(store.calls, []);
});

test('stale fixture data blocks a new snapshot but does not block an existing run snapshot', async () => {
  const match = {id: 1, kickoff: '2026-01-08T12:00:00Z'};
  const old = '2026-01-06T08:00:00Z';
  let providerCalls = 0;
  const freshRun = fakeStore([match], old);
  assert.deepEqual(await generateWeeklyPredictions(freshRun, {jev: async () => { providerCalls++; }}, '2026-01-07T09:00:00Z'),
    {targeted: 1, updated: 0, failed: 0});
  assert.equal(providerCalls, 0);
  assert.equal(freshRun.calls.some(call => call[0] === 'snapshot'), false);

  const reused = fakeStore([match], old, [{fixtureId: 1, input: match}]);
  assert.deepEqual(await generateWeeklyPredictions(reused, {jev: async () => { providerCalls++; return {}; }}, '2026-01-07T09:00:00Z'),
    {targeted: 1, updated: 1, failed: 0});
  assert.equal(providerCalls, 1);
  assert.equal(reused.calls.some(call => call[0] === 'snapshot'), false);
});

test('a provider response completed at kickoff is counted as a failed attempt', async () => {
  const now = '2026-01-07T09:00:00Z';
  const match = {id: 1, kickoff: '2026-01-08T12:00:00Z'};
  const store = fakeStore([match], now);
  store.savePrediction = async () => false;
  const result = await generateWeeklyPredictions(store, {jev: async () => ({})}, now);
  assert.deepEqual(result, {targeted: 1, updated: 0, failed: 1});
  assert.ok(store.calls.some(call => call[0] === 'attempt' && call[2] === 'failed'));
});
