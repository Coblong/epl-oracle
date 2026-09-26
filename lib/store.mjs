import {put, get} from '@vercel/blob';

export async function readJSON(pathname, fallback = null) {
  const result = await get(pathname, {access: 'public'});
  if (!result) return fallback;
  return JSON.parse(await new Response(result.stream).text());
}

export async function writeJSON(pathname, data) {
  await put(pathname, JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}
