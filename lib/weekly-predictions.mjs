import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';

const LONDON = 'Europe/London';
const TEN_DAYS_MS = 240 * 60 * 60 * 1000;
const FIXTURE_DATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_PROVIDER_CONCURRENCY = 6;

const partsAt = (instant, timeZone = LONDON) => Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]),
);

function londonInstant(year, month, day, hour) {
  const guess = Date.UTC(year, month - 1, day, hour);
  const local = partsAt(new Date(guess));
  const representedAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return new Date(guess - (representedAsUtc - guess));
}

function latestScheduledAt(now) {
  const instant = new Date(now);
  const local = partsAt(instant);
  const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const daysSinceWednesday = (localDate.getUTCDay() - 3 + 7) % 7;
  localDate.setUTCDate(localDate.getUTCDate() - daysSinceWednesday);
  let scheduledAt = londonInstant(localDate.getUTCFullYear(), localDate.getUTCMonth() + 1, localDate.getUTCDate(), 9);
  if (instant < scheduledAt) {
    localDate.setUTCDate(localDate.getUTCDate() - 7);
    scheduledAt = londonInstant(localDate.getUTCFullYear(), localDate.getUTCMonth() + 1, localDate.getUTCDate(), 9);
  }
  return scheduledAt;
}

export function weeklyRunContext(now = new Date()) {
  const instant = new Date(now);
  const scheduledAt = latestScheduledAt(instant);
  const recoveryUntil = new Date(scheduledAt.getTime() + 24 * 60 * 60 * 1000);
  if (instant < scheduledAt || instant >= recoveryUntil) return null;
  return {
    key: `weekly:${scheduledAt.toISOString()}`,
    scheduledAt,
    windowStart: scheduledAt,
    windowEnd: new Date(scheduledAt.getTime() + TEN_DAYS_MS),
    recoveryUntil,
  };
}

export function expectedWeeklyRunKey(now = new Date()) {
  return `weekly:${latestScheduledAt(now).toISOString()}`;
}

export function eligibleWeeklyFixtures(matches, now, context) {
  const instant = new Date(now).getTime();
  return matches.filter(match => {
    if (!match.kickoff) return false;
    const kickoff = Date.parse(match.kickoff);
    return Number.isFinite(kickoff) && kickoff > instant
      && kickoff >= context.windowStart.getTime() && kickoff < context.windowEnd.getTime();
  });
}

export async function generateWeeklyPredictions(store, providers, now = new Date(), wait = delay, clock = () => new Date()) {
  await store.settleAttempts?.(new Date(now).toISOString());
  const context = weeklyRunContext(now);
  if (!context) return {targeted: 0, updated: 0, failed: 0, skipped: 'outside weekly run window'};
  const fixtures = await store.getFixtures();
  if (!fixtures) return {targeted: 0, updated: 0, failed: 0, skipped: 'fixtures are unavailable'};
  const targets = eligibleWeeklyFixtures(fixtures.matches, now, context);
  if (!targets.length || !Object.keys(providers).length) return {targeted: targets.length, updated: 0, failed: 0};

  const run = await store.beginRun(context.key, context.scheduledAt.toISOString());
  const runState = await store.getRun(run.id);
  let updated = 0;
  let failed = 0;
  const dataAge = new Date(now).getTime() - Date.parse(fixtures.updatedAt);
  const work = [];

  for (const match of targets) {
    const priorSnapshot = runState.snapshots.find(snapshot => snapshot.fixtureId === match.id);
    if (!priorSnapshot && (!Number.isFinite(dataAge) || dataAge > FIXTURE_DATA_MAX_AGE_MS)) continue;
    const snapshot = priorSnapshot
      ? priorSnapshot.input
      : await store.saveSnapshot(run.id, match.id, match);
    const matchSignature = JSON.stringify(snapshot);

    for (const [provider, generate] of Object.entries(providers)) {
      work.push(async () => {
        await wait(300);
        const attempt = {runId: run.id, fixtureId: match.id, provider, claimUntil: context.recoveryUntil.toISOString(),attemptAt:clock().toISOString(),claimToken:randomUUID()};
        if (!await store.claimAttempt(attempt)) return;
        try {
          const prediction = await generate(structuredClone(snapshot));
          const completedAt = clock().toISOString();
          if (await store.savePrediction({...attempt, matchSignature, prediction, completedAt})) {
            updated++;
          } else {
            failed++;
            await store.recordAttempt({...attempt,attemptAt:clock().toISOString(), status: 'failed', error: 'Fixture changed or kickoff passed during prediction.'});
          }
        } catch {
          failed++;
          await store.recordAttempt({...attempt,attemptAt:clock().toISOString(), status: 'failed', error: 'Provider prediction failed.'});
        }
      });
    }
  }
  let next = 0;
  await Promise.all(Array.from({length: Math.min(MAX_PROVIDER_CONCURRENCY, work.length)}, async () => {
    while (next < work.length) await work[next++]();
  }));
  return {targeted: targets.length, updated, failed};
}
