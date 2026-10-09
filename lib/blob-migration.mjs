import {randomUUID} from 'node:crypto';
import {head, copy, get, del, BlobNotFoundError, BlobPreconditionFailedError} from '@vercel/blob';

// The CDN may mark the same validator weak when it compresses a JSON response.
const entityTag = etag => etag?.replace(/^W\//, '');

// Public get() can return cached content even with useCache:false. Copy through
// the authenticated storage API to a never-used URL before reading any bytes.
export function createMigrationReader(blob = {head, copy, get, del}) {
  return async (pathname, fallback = null) => {
    let source;
    try { source = await blob.head(pathname); }
    catch (error) {
      if (error instanceof BlobNotFoundError) return fallback;
      throw error;
    }
    if (!source.etag) throw new Error('Blob source has no ETag. Cannot verify migration data.');
    let copied;
    try {
      copied = await blob.copy(source.url, `migration-snapshots/${randomUUID()}/${pathname}`, {
        access:'public', addRandomSuffix:false, allowOverwrite:false,
        contentType:'application/json', cacheControlMaxAge:60, ifMatch:source.etag,
      });
      const response = await blob.get(copied.url, {access:'public'});
      if (!copied.etag || !response || response.statusCode !== 200 || entityTag(response.blob.etag) !== entityTag(copied.etag)) {
        throw new Error('Blob copy verification failed. Refusing unverified migration data.');
      }
      const data = JSON.parse(await new Response(response.stream).text());
      const after = await blob.head(pathname);
      if (after.etag !== source.etag) throw new Error('Blob changed during export. Pause legacy writers and retry.');
      return data;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError || error instanceof BlobNotFoundError) {
        throw new Error('Blob changed during export. Pause legacy writers and retry.');
      }
      throw error;
    } finally {
      // Only delete the unique copy created by this read, never a live document.
      if (copied) await blob.del(copied.url);
    }
  };
}
