// This file is the PRODUCER side of your background jobs. It ADDS jobs to the
// BullMQ queues in Redis. (The workers, worker.js and webhookWorker.js, are the
// other side: they take jobs out and run them.)
//
// The big picture:
//   Your code ──addBookingJob()──► Redis queue "email"    ──► email worker
//   Your code ──addWebhookJob()──► Redis queue "webhooks" ──► webhook worker
//
// It uses producerRedis from redis.js (the "fail fast" connection), so a Redis
// problem never makes a request hang.
//
// getQueue(name, options)
//   Creates a queue ONE time and reuses it later (stored in the `queues` Map).
//   Also adds an error listener that logs at most once every 10 seconds,
//   so a Redis outage does not flood the console.
//
// The 2 queues and their retry settings (defaultJobOptions):
//   "email"      attempts: 3, wait 2s, then 4s (exponential backoff)
//                keeps the last 100 finished and 500 failed jobs
//   "webhooks"   attempts and wait time come from webhooks.constants.js
//                keeps the last 1000 finished and 1000 failed jobs
//   "Exponential backoff" means each retry waits longer than the one before.
//
// closeQueues()
//   Closes all queues cleanly. Call it when the server shuts down.
//
// withTimeout(promise, ms)
//   Helper that gives up after ENQUEUE_TIMEOUT_MS (2 seconds). Without it, adding
//   a job could wait a long time if Redis is down.
//
// addBookingJob(name, data)   adds an email/notification job
//   - In tests (NODE_ENV = "test") it does nothing
//   - Adds requestId to the data, so logs can be traced to the original request
//   - jobId = "<name>-<bookingId>", for example "booking-confirmed-123".
//     BullMQ ignores a job with an id that already exists, so the same booking
//     event is never queued twice (no duplicate emails)
//   - FALLBACK: if Redis is down or too slow, it does not lose the message.
//     It calls notify() directly to save the notification right away.
//     (The email is skipped in this case, but the in-app notification still exists.)
//
// addWebhookJob(data)   adds ONE delivery of ONE event to ONE endpoint
//   - In tests it returns true without doing anything
//   - jobId = data.deliveryId, so the same delivery is never queued twice
//   - Returns true if queued, false if it failed
//   - NO fallback: a webhook needs the retry system, so if Redis is down the
//     delivery is skipped and an error is logged

import { Queue } from "bullmq";
import { producerRedis } from "../config/redis.js";
import { NODE_ENV } from "../config/env.js";
import { notify } from "../modules/notifications/notifications.service.js";
import { describeBookingJob } from "./bookingMessages.js";
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_BACKOFF_MS,
} from "../modules/webhooks/webhooks.constants.js";
import logger, { currentRequestId } from "../utils/logger.js";

const queues = new Map();

function getQueue(name, defaultJobOptions) {
  if (queues.has(name)) return queues.get(name);

  const queue = new Queue(name, {
    connection: producerRedis,
    defaultJobOptions,
  });

  let lastLogged = 0;
  queue.on("error", (err) => {
    if (Date.now() - lastLogged > 10_000) {
      lastLogged = Date.now();
      logger.error(`[queue:${name}] error:`, err.message);
    }
  });

  queues.set(name, queue);
  return queue;
}

const getEmailQueue = () =>
  getQueue("email", {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  });

const getWebhookQueue = () =>
  getQueue("webhooks", {
    attempts: WEBHOOK_MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: WEBHOOK_BACKOFF_MS },
    removeOnComplete: 1000,
    removeOnFail: 1000,
  });

export async function closeQueues() {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}

const ENQUEUE_TIMEOUT_MS = 2000;
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`timed out after ${ms}ms (is Redis down?)`)),
        ms,
      ).unref(),
    ),
  ]);

export async function addBookingJob(name, data) {
  if (NODE_ENV === "test") return;

  const payload = { ...data, requestId: currentRequestId() };

  try {
    await withTimeout(
      getEmailQueue().add(name, payload, {
        jobId: `${name}-${data.bookingId}`,
      }),
      ENQUEUE_TIMEOUT_MS,
    );
  } catch (err) {
    logger.error(`[queue] could not enqueue ${name}:`, err.message);
    const { type, message } = describeBookingJob(name, data);
    await notify({
      userId: data.userId,
      type,
      message,
      meta: {
        bookingId: data.bookingId,
        eventId: data.eventId,
        quantity: data.quantity,
      },
    });
  }
}

export async function addWebhookJob(data) {
  if (NODE_ENV === "test") return true;

  try {
    await withTimeout(
      getWebhookQueue().add(
        "deliver",
        { ...data, requestId: currentRequestId() },
        { jobId: data.deliveryId },
      ),
      ENQUEUE_TIMEOUT_MS,
    );
    return true;
  } catch (err) {
    logger.error(
      `[queue] could not enqueue webhook ${data.event}:`,
      err.message,
    );
    return false;
  }
}
