import { cacheRedis } from '../config/redis.js';
import { NODE_ENV } from '../config/env.js';
import logger from './logger.js';

const VERSION_KEY = 'events:version';

// Cache-aside with a VERSIONED key.
//
//   key = events:v<version>:<query>
//
// To "clear the cache" we don't hunt down keys, we just INCR the version. Every old
// key instantly becomes unreachable (and expires on its own via the TTL). That is O(1),
// needs no KEYS/SCAN, and has no stale-write race: a slow request that read the DB just
// before an invalidation stores its result under the OLD version, which nobody reads again.
//
// Redis is an optimisation, never a dependency: every Redis call is wrapped so that if
// Redis is down the request simply falls through to the database.
export async function cached(queryKey, ttlSeconds, loader) {
  // Tests must always see fresh database state, so the cache is switched off.
  if (NODE_ENV === 'test') return { value: await loader(), hit: false };

  let key = null;

  try {
    const version = (await cacheRedis.get(VERSION_KEY)) ?? '0';
    key = `events:v${version}:${queryKey}`;
    const hit = await cacheRedis.get(key);
    if (hit) return { value: JSON.parse(hit), hit: true };
  } catch {
    key = null; // Redis unavailable: skip the cache entirely
  }

  const value = await loader();

  if (key) {
    try {
      await cacheRedis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // ignore: the response is still correct, just not cached
    }
  }
  return { value, hit: false };
}

// Call after anything that changes what GET /events would return
// (event created/updated/deleted, seats changed, event finished).
export async function invalidateEventsCache() {
  if (NODE_ENV === 'test') return;
  try {
    await cacheRedis.incr(VERSION_KEY);
  } catch (err) {
    logger.error('Cache invalidation failed:', err.message);
  }
}
