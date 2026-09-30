import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import prisma from '../../config/prisma.js';
import logger from '../../utils/logger.js';
import { addWebhookJob } from '../../jobs/queue.js';
import WebhookDelivery from './webhookDelivery.model.js';
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_MAX_CONSECUTIVE_FAILURES,
} from './webhooks.constants.js';
import {
  ALLOW_PRIVATE_TARGETS,
  assertHostAllowed,
  makeSafeLookup,
  signPayload,
} from './webhooks.security.js';

// The JSON every receiver gets. `id` is the delivery id: receivers should remember the ids
// they have processed, because delivery is "at least once" (a retry can duplicate an event).
export function buildEnvelope(deliveryId, event, data) {
  return { id: deliveryId, event, createdAt: new Date().toISOString(), data };
}

// ---------------------------------------------------------------------------
// DISPATCH: called from the request that caused the event (after its DB commit).
// Finds who subscribed and queues one job per endpoint. It never throws: a webhook
// problem must not turn a successful booking into an error response.
// ---------------------------------------------------------------------------
export async function dispatchWebhook(event, data, { enqueue = addWebhookJob } = {}) {
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({ where: { active: true } });
    const targets = endpoints.filter((endpoint) => endpoint.events.includes(event));

    await Promise.all(
      targets.map((endpoint) => {
        const deliveryId = randomUUID();
        return enqueue({
          endpointId: endpoint.id,
          deliveryId,
          event,
          payload: buildEnvelope(deliveryId, event, data),
        });
      }),
    );
    return targets.length;
  } catch (err) {
    logger.error(`[webhooks] dispatch of ${event} failed:`, err.message);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// HTTP: one POST with a timeout. Uses node:http(s) instead of fetch so we can plug in
// makeSafeLookup and re-check the destination IP at connection time.
// Redirects are NOT followed (http.request never does), so a receiver cannot bounce us
// to an internal address; a 3xx simply counts as a failed attempt.
// ---------------------------------------------------------------------------
export function postJson(rawUrl, { headers, body, timeoutMs = WEBHOOK_TIMEOUT_MS, allowPrivate = ALLOW_PRIVATE_TARGETS }) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
      assertHostAllowed(url, allowPrivate);
    } catch (err) {
      return reject(err);
    }

    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'EventBooking-Webhooks/1.0',
          ...headers,
        },
        lookup: makeSafeLookup(allowPrivate),
        timeout: timeoutMs, // idle timeout on the socket
      },
      (response) => {
        response.resume(); // we only need the status code, so throw the body away
        response.on('end', () => {
          clearTimeout(deadline);
          resolve({ status: response.statusCode });
        });
      },
    );

    // The socket timeout resets whenever bytes arrive, so a receiver that drips data slowly
    // could hold us forever. This overall deadline stops that.
    const deadline = setTimeout(() => request.destroy(new Error('overall deadline exceeded')), timeoutMs * 2);
    request.on('timeout', () => request.destroy(new Error(`no response within ${timeoutMs}ms`)));
    request.on('error', (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    request.end(body);
  });
}

// ---------------------------------------------------------------------------
// DELIVERY LOG (MongoDB). Best effort: a logging problem must not change the outcome.
// ---------------------------------------------------------------------------
export async function recordDelivery(entry) {
  try {
    await WebhookDelivery.updateOne(
      { deliveryId: entry.deliveryId },
      { $set: entry },
      { upsert: true },
    );
  } catch (err) {
    logger.error('[webhooks] could not save delivery log:', err.message);
  }
}

async function registerFinalFailure(endpointId) {
  const { failureCount } = await prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: { failureCount: { increment: 1 } },
    select: { failureCount: true },
  });

  if (failureCount >= WEBHOOK_MAX_CONSECUTIVE_FAILURES) {
    await prisma.webhookEndpoint.update({ where: { id: endpointId }, data: { active: false } });
    logger.warn(`[webhooks] endpoint ${endpointId} disabled after ${failureCount} failed deliveries in a row`);
  }
}

// ---------------------------------------------------------------------------
// DELIVER: runs inside the BullMQ worker, once per attempt.
//   2xx        -> success
//   anything else, or a network error/timeout -> THROW, so BullMQ retries with backoff
// The options exist so tests can inject a fake logger and a small attempt limit.
// ---------------------------------------------------------------------------
export async function deliverWebhook(
  { endpointId, deliveryId, event, payload },
  {
    attempt = 1,
    maxAttempts = WEBHOOK_MAX_ATTEMPTS,
    record = recordDelivery,
    allowPrivate = ALLOW_PRIVATE_TARGETS,
    timeoutMs = WEBHOOK_TIMEOUT_MS,
  } = {},
) {
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId } });
  const base = { deliveryId, endpointId, event, payload, attempts: attempt };

  // Deleted or disabled while the job was waiting: stop quietly, no retries.
  if (!endpoint || !endpoint.active) {
    await record({ ...base, status: 'SKIPPED', lastError: 'endpoint missing or disabled' });
    return { skipped: true };
  }

  // Sign the exact bytes we send. A fresh timestamp on every attempt keeps retries valid
  // for receivers that reject old timestamps.
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    'x-webhook-id': deliveryId,
    'x-webhook-event': event,
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature': signPayload(endpoint.secret, timestamp, body),
  };

  let status = null;
  let error = null;
  try {
    ({ status } = await postJson(endpoint.url, { headers, body, allowPrivate, timeoutMs }));
    if (status < 200 || status >= 300) error = `receiver answered HTTP ${status}`;
  } catch (err) {
    error = err.message;
  }

  if (!error) {
    await record({ ...base, status: 'SUCCESS', lastStatusCode: status, lastError: null });
    if (endpoint.failureCount > 0) {
      await prisma.webhookEndpoint.update({ where: { id: endpointId }, data: { failureCount: 0 } });
    }
    return { status };
  }

  const isLastAttempt = attempt >= maxAttempts;
  await record({
    ...base,
    status: isLastAttempt ? 'FAILED' : 'RETRYING',
    lastStatusCode: status,
    lastError: error,
  });
  if (isLastAttempt) await registerFinalFailure(endpointId);

  throw new Error(error); // tells BullMQ this attempt failed
}
