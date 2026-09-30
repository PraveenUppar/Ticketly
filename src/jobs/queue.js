import { Queue } from 'bullmq';
import { producerRedis } from '../config/redis.js';
import { NODE_ENV } from '../config/env.js';
import { notify } from '../modules/notifications/notifications.service.js';
import { describeBookingJob } from './bookingMessages.js';
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_BACKOFF_MS } from '../modules/webhooks/webhooks.constants.js';
import logger, { currentRequestId } from '../utils/logger.js';

// Queues are created on first use, so importing this file (e.g. from a test) never touches Redis.
const queues = new Map();

function getQueue(name, defaultJobOptions) {
  if (queues.has(name)) return queues.get(name);

  const queue = new Queue(name, { connection: producerRedis, defaultJobOptions });

  // Queue emits 'error' when Redis is unreachable; unhandled, that would crash the process.
  // Logged at most once every 10s so an outage doesn't flood the console.
  let lastLogged = 0;
  queue.on('error', (err) => {
    if (Date.now() - lastLogged > 10_000) {
      lastLogged = Date.now();
      logger.error(`[queue:${name}] error:`, err.message);
    }
  });

  queues.set(name, queue);
  return queue;
}

const getEmailQueue = () =>
  getQueue('email', {
    attempts: 3, // try up to 3 times...
    backoff: { type: 'exponential', delay: 2000 }, // ...waiting 2s, then 4s between tries
    removeOnComplete: 100, // keep only the last 100 finished jobs in Redis
    removeOnFail: 500,
  });

const getWebhookQueue = () =>
  getQueue('webhooks', {
    attempts: WEBHOOK_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: WEBHOOK_BACKOFF_MS },
    removeOnComplete: 1000,
    removeOnFail: 1000,
  });

export async function closeQueues() {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}

// BullMQ's add() WAITS for Redis to come back instead of failing when it is down,
// which would make the booking request hang. So we give it a deadline.
const ENQUEUE_TIMEOUT_MS = 2000;
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms (is Redis down?)`)), ms).unref(),
    ),
  ]);

// Called by the booking controller AFTER the MySQL transaction has committed.
// The HTTP response does not wait for the email: it only waits for "job queued" (a few ms).
export async function addBookingJob(name, data) {
  if (NODE_ENV === 'test') return; // tests don't run Redis or a worker

  // Carry the request ID inside the job, so the worker's log lines can be traced
  // back to the HTTP request that caused them.
  const payload = { ...data, requestId: currentRequestId() };

  try {
    // jobId makes it idempotent: adding the same booking event twice creates ONE job,
    // which also covers a slow add() that finishes after we already timed out.
    // (BullMQ forbids ':' in custom ids, hence the dash.)
    await withTimeout(
      getEmailQueue().add(name, payload, { jobId: `${name}-${data.bookingId}` }),
      ENQUEUE_TIMEOUT_MS,
    );
  } catch (err) {
    // Redis is down. The booking is already saved, so never fail the request.
    // Fallback: still write the notification log directly (no email in this case).
    logger.error(`[queue] could not enqueue ${name}:`, err.message);
    const { type, message } = describeBookingJob(name, data);
    await notify({
      userId: data.userId,
      type,
      message,
      meta: { bookingId: data.bookingId, eventId: data.eventId, quantity: data.quantity },
    });
  }
}

// One job = one delivery of one event to one endpoint. Returns true if it was queued.
// Unlike emails there is no direct fallback: a webhook needs the retry machinery, so if
// Redis is down the delivery is skipped and logged (see "known limitations" in the README).
export async function addWebhookJob(data) {
  if (NODE_ENV === 'test') return true; // tests don't run Redis or a worker

  try {
    await withTimeout(
      getWebhookQueue().add(
        'deliver',
        { ...data, requestId: currentRequestId() },
        { jobId: data.deliveryId },
      ),
      ENQUEUE_TIMEOUT_MS,
    );
    return true;
  } catch (err) {
    logger.error(`[queue] could not enqueue webhook ${data.event}:`, err.message);
    return false;
  }
}
