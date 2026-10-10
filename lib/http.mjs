import {setTimeout as delay} from 'node:timers/promises';

export async function jsonFetch(url, options = {}, {attempts = 3} = {}) {
  let r;
  for (let attempt = 0; attempt < attempts; attempt++) {
    r = await fetch(url, {...options, signal: AbortSignal.timeout(30000)});
    if (![429, 502, 503, 504].includes(r.status) || attempt === attempts - 1) break;
    const retry = Number(r.headers.get('retry-after'));
    await r.body?.cancel();
    await delay(Math.min(30000, Math.max(10000, Number.isFinite(retry) ? retry * 1000 : 0) * (attempt + 1)));
  }
  if (!r.ok) throw Object.assign(new Error(`Upstream request failed (${r.status})`), {status: r.status});
  return r.json();
}
