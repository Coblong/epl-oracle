import {readJSON} from '../lib/store.mjs';
import {accuracySummary} from '../lib/football.mjs';

const json = (res, status, data) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, {error: 'Method not allowed'});
  try {
    const results = (await readJSON('data/results.json')) || [];
    const sorted = [...results].sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff));
    return json(res, 200, {
      results: sorted.slice(0, 20),
      summary: accuracySummary(results),
    });
  } catch (e) {
    console.error(e);
    return json(res, 502, {error: 'Unable to load the track record. Please try again.'});
  }
}
