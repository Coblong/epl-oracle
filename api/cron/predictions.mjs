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
  const providers = {jev:predictMatch,openai:predictDecision};
  const now = new Date();
  const context = weeklyRunContext(now);
  if (process.env.PERSISTENCE_BACKEND !== 'neon') return json(res, context ? 409 : 200, context
    ? {error:'Dual-provider predictions require validated Neon persistence.'}
    : {ok:true,skipped:'Outside the weekly forecast recovery window.'});
  try {
    const store = getStore();
    const stats = await generateWeeklyPredictions(store, providers, now);
    return json(res, 200, {ok:true, ...(context ? {run:context.key} : {}), ...stats});
  } catch (e) {
    console.error('Weekly prediction job failed. Check server configuration.');
    return json(res, 502, {error:'Unable to generate predictions. Check server configuration and retry.'});
  }
}
