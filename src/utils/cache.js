// This file handles CACHING for the events list, using Redis (cacheRedis).
// A cache keeps a saved copy of an answer, so next time you do not need to ask
// MySQL again. Reading from Redis is much faster than running a database query.
//
// It exports 2 functions:
//
// cached(queryKey, ttlSeconds, loader)
//   "Give me this data from the cache. If it is not there, load it and save it."
//     queryKey     a name for this query (example: "city=Delhi&page=1")
//     ttlSeconds   how long the saved copy lives. After that, Redis deletes it.
//     loader       a function that gets the real data (usually a Prisma query)
//   It returns { value, hit }:
//     hit: true    the data came from Redis (fast)
//     hit: false   the data came from loader() (the database)
//
//   Steps:
//     1. In tests (NODE_ENV = "test"), skip the cache and always call loader()
//     2. Read the current version number from Redis
//     3. Build the key:  events:v<version>:<queryKey>   (example: events:v3:city=Delhi)
//     4. If Redis has that key, return the saved data
//     5. If not (a cache "miss"), call loader() to get real data,
//        then save it in Redis with an expiry time ("EX", ttlSeconds)
//
//   If Redis is down, the try/catch means: skip the cache and just use loader().
//   The user still gets the data, only slower. A cache problem never breaks the app.
//   (This is why cacheRedis in redis.js is set to "fail fast".)
//
// invalidateEventsCache()
//   Tells the cache "the events changed, your old copies are wrong."
//   Call it after creating, updating, or finishing an event
//   (cron.js calls it in markFinishedEvents).
//
//   The trick: VERSION NUMBER
//     Deleting many cache keys one by one is slow and hard.
//     So instead, the version number goes up by 1 (incr), and the version is part of every key.
//       Before:  events:v3:city=Delhi      (the old copy)
//       After:   the version becomes 4, so the app now looks for
//                events:v4:city=Delhi      (not found, so it loads fresh data)
//     The old v3 keys are never used again and disappear when their TTL ends.
//     One small command invalidates ALL cached events lists at once.

import { cacheRedis } from "../config/redis.js";
import { NODE_ENV } from "../config/env.js";
import logger from "./logger.js";

const VERSION_KEY = "events:version";

export async function cached(queryKey, ttlSeconds, loader) {
  if (NODE_ENV === "test") return { value: await loader(), hit: false };

  let key = null;

  try {
    const version = (await cacheRedis.get(VERSION_KEY)) ?? "0";
    key = `events:v${version}:${queryKey}`;
    const hit = await cacheRedis.get(key);
    if (hit) return { value: JSON.parse(hit), hit: true };
  } catch {
    key = null; // Redis unavailable: skip the cache entirely
  }

  const value = await loader();

  if (key) {
    try {
      await cacheRedis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch {}
  }
  return { value, hit: false };
}

export async function invalidateEventsCache() {
  if (NODE_ENV === "test") return;
  try {
    await cacheRedis.incr(VERSION_KEY);
  } catch (err) {
    logger.error("Cache invalidation failed:", err.message);
  }
}
