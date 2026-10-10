import {getStore} from '../../lib/store.mjs';
import {generateWeeklyPredictions, weeklyRunContext} from '../../lib/weekly-predictions.mjs';
import {authorizeCron} from '../../lib/cron-auth.mjs';
import {predictMatch} from '../../lib/jev.mjs';
import {predictDecision} from '../../lib/decisions.mjs';

const json = (res, status, data) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
};

export default async function handler(req, res) {
  if (!authorizeCron(req)) return json(res, 401, {error: 'Unauthorized'});
  const providers = {};
  if (process.env.AI_GATEWAY_API_KEY) providers.jev = predictMatch;
  if (process.env.OPENAI_API_KEY) providers.openai = predictDecision;
  const now = new Date();
  const context = weeklyRunContext(now);
  if (!context) return json(res, 200, {ok:true, skipped:'Outside the Wednesday forecast window.'});
  if (!Object.keys(providers).length) return json(res, 200, {ok:true, skipped:'No prediction providers are configured.'});
  if (providers.openai && process.env.PERSISTENCE_BACKEND !== 'neon') return json(res, 409, {error:'Dual-provider predictions require validated Neon persistence.'});
  try {
    const store = getStore();
    const stats = await generateWeeklyPredictions(store, providers, now);
    return json(res, 200, {ok:true, run:context.key, ...stats});
  } catch (e) {
    console.error(e);
    return json(res, 502, {error:'Unable to generate predictions. Check server configuration and retry.'});
  }
}
