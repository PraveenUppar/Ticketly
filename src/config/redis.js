// This file creates the Redis connections for your app.
// Why 3 different connections?
// Each job needs different behavior when Redis is slow or down.
//
//   cacheRedis        for caching.
//                     Must FAIL FAST. If Redis is down, skip the cache and
//                     read from MySQL instead of making the user wait.
//
//   producerRedis     for ADDING jobs to the queue (example: after a booking).
//                     Also fails fast, so a booking request never hangs
//                     waiting for Redis.
//
//   createWorkerRedis for the WORKER that reads and runs jobs.
//                     Workers wait for new jobs using blocking commands.
//                     BullMQ requires maxRetriesPerRequest: null here,
//                     which means "keep retrying forever". That is what a
//                     worker needs, because it should wait until Redis is back.
//
// Helper settings:
//   withErrorLogging  adds an 'error' listener to each client.
//                     Without it, a Redis outage would crash Node.
//                     It logs at most once every 10 seconds, so a down Redis
//                     does not flood your console.
//
//   lazyConnect       in tests (NODE_ENV = "test"), do not connect until the
//                     first command is sent. So tests never open a real
//                     Redis connection by accident.
//
//   retryStrategy     if the connection drops, wait longer each time before
//                     retrying: 500ms, 1000ms, 1500ms ... up to 5000ms (5 seconds).

import Redis from "ioredis";
import { REDIS_URL, NODE_ENV } from "./env.js";
import logger from "../utils/logger.js";

function withErrorLogging(client, name) {
  let lastLogged = 0;
  client.on("error", (err) => {
    const now = Date.now();
    if (now - lastLogged > 10_000) {
      lastLogged = now;
      logger.error(`[redis:${name}] ${err.message}`);
    }
  });
  return client;
}

const lazyConnect = NODE_ENV === "test";

const retryStrategy = (times) => Math.min(times * 500, 5000);

// reading/saving cached data
export const cacheRedis = withErrorLogging(
  new Redis(REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
    lazyConnect,
    retryStrategy,
  }),
  "cache",
);

// adding jobs to the queue
export const producerRedis = withErrorLogging(
  new Redis(REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect,
    retryStrategy,
  }),
  "queue",
);

// the worker
export const createWorkerRedis = () =>
  withErrorLogging(
    new Redis(REDIS_URL, { maxRetriesPerRequest: null, retryStrategy }),
    "worker",
  );
