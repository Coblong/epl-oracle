import {AGENTS} from '../agents.mjs';
import {fixtureFreshness} from '../fixture-freshness.mjs';
import {getStore} from '../lib/store.mjs';

const json = (res, status, data) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});
  try {
    const requestedPage=req.query?.page ?? (req.url ? new URL(req.url,'http://localhost').searchParams.get('page') : null);
    const store=getStore();
    const resultPage=await store.getResultsPage({page:requestedPage ?? 1,pageSize:20});
    const fixtures=await store.getFixtures();
    return json(res, 200, {...resultPage,agents:AGENTS,fixtureRefresh:fixtureFreshness(fixtures?.updatedAt)});
  } catch (e) {
    console.error(e);
    return json(res, 502, {error: 'Unable to load the track record. Please try again.'});
  }
}
