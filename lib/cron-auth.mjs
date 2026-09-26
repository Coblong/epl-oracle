import {timingSafeEqual} from 'node:crypto';

export function authorizeCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.authorization ?? req.headers.Authorization ?? '';
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
