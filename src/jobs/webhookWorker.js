import { Worker } from 'bullmq';
import { createWorkerRedis } from '../config/redis.js';
import { deliverWebhook } from '../modules/webhooks/webhooks.service.js';
import { WEBHOOK_MAX_ATTEMPTS } from '../modules/webhooks/webhooks.constants.js';
import logger, { requestContext } from '../utils/logger.js';

export function startWebhookWorker() {
  const worker = new Worker(
    'webhooks',
    (job) =>
      // same trick as the email worker: log lines carry the original request's ID
      requestContext.run({ requestId: job.data.requestId ?? `job-${job.id}` }, () =>
        deliverWebhook(job.data, {
          attempt: job.attemptsStarted, // 1 on the first try, 2 on the first retry, ...
          maxAttempts: job.opts.attempts ?? WEBHOOK_MAX_ATTEMPTS,
        }),
      ),
    // deliveries are slow network calls that mostly wait, so run many at once
    { connection: createWorkerRedis(), concurrency: 10 },
  );

  worker.on('completed', (job) => logger.info(`[webhook-worker] delivered ${job.data.event} (${job.id})`));
  worker.on('failed', (job, err) =>
    logger.warn(`[webhook-worker] ${job?.data?.event} (${job?.id}) attempt ${job?.attemptsStarted} failed: ${err.message}`),
  );
  worker.on('error', (err) => logger.error('[webhook-worker] error:', err.message));

  return worker;
}
