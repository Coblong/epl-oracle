import {getStore} from '../lib/store.mjs';
import {fingerprint} from '../lib/migration.mjs';

const json = (res, status, data) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});
  try {
    const {fixtures, predictions, providerPredictions} = await getStore().getFixtureView();
    if (!fixtures) return json(res, 503, {error: 'Fixtures have not been loaded yet. Please check back shortly.', configured: !!process.env.AI_GATEWAY_API_KEY});
    const now = Date.now();
    const matches = fixtures.matches
      .filter(m => !m.kickoff || Date.parse(m.kickoff) > now)
      .map(m => {
        const entry = predictions[m.id];
        let matches = entry?.matchSignature === JSON.stringify(m);
        if (entry && !matches) {
          try { matches = fingerprint(JSON.parse(entry.matchSignature)) === fingerprint(m); } catch {}
        }
        const forecasts = {};
        for (const [provider,forecast] of Object.entries(providerPredictions?.[m.id] ?? (entry ? {jev:entry} : {}))) {
          let stale = true;
          try { stale = fingerprint(JSON.parse(forecast.matchSignature)) !== fingerprint(m); } catch {}
          forecasts[provider] = {...forecast.prediction, provider, stale};
        }
        return {...m, ...(matches ? {prediction:entry.prediction} : {}), predictions:forecasts};
      });
    return json(res, 200, {
      matches,
      source: fixtures.source,
      updatedAt: fixtures.updatedAt,
      configured: !!process.env.AI_GATEWAY_API_KEY,
      providersConfigured:{jev:!!process.env.AI_GATEWAY_API_KEY, openai:!!process.env.OPENAI_API_KEY},
    });
  } catch (e) {
    console.error(e);
    return json(res, 502, {error: 'Unable to load the official fixture feed. Please try again.'});
  }
}
