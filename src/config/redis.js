import Redis from 'ioredis';
import { REDIS_URL, NODE_ENV } from './env.js';
import logger from '../utils/logger.js';

// Without an 'error' listener, a Redis outage would crash Node (unhandled 'error' event).
// We log at most once every 10s so a down Redis doesn't flood the console.
function withErrorLogging(client, name) {
  let lastLogged = 0;
  client.on('error', (err) => {
    const now = Date.now();
    if (now - lastLogged > 10_000) {
      lastLogged = now;
      logger.error(`[redis:${name}] ${err.message}`);
    }
  });
  return client;
}

// In tests we never want to open a real Redis connection: lazyConnect waits for the first command.
const lazyConnect = NODE_ENV === 'test';

const retryStrategy = (times) => Math.min(times * 500, 5000);

// 1) CACHE client: must FAIL FAST. If Redis is down we want the request to skip the
//    cache and hit MySQL, not hang. So: no offline queue, short command timeout.
export const cacheRedis = withErrorLogging(
  new Redis(REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
    lazyConnect,
    retryStrategy,
  }),
  'cache',
);

// 2) PRODUCER connection for adding jobs to the queue: also fail fast, so a booking
//    request never hangs waiting for Redis.
export const producerRedis = withErrorLogging(
  new Redis(REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect,
    retryStrategy,
  }),
  'queue',
);

// 3) WORKER connection: BullMQ workers use blocking commands, and BullMQ REQUIRES
//    maxRetriesPerRequest: null here (it keeps retrying forever, which is what we want).
export const createWorkerRedis = () =>
  withErrorLogging(new Redis(REDIS_URL, { maxRetriesPerRequest: null, retryStrategy }), 'worker');
