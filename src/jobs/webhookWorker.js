// This file is the BACKGROUND WORKER for OUTGOING webhooks.
// It takes jobs from the "webhooks" queue and sends the notification
// (an HTTP POST) to the URLs that admins registered in WebhookEndpoint.
//
// It works like the email worker, but for a different queue:
//   email worker     queue "email"      sends emails + saves notifications
//   webhook worker   queue "webhooks"   POSTs events to admin URLs
//
// The big picture:
//   Booking confirmed ──adds job──► Redis queue ("webhooks") ──► this Worker
//                                                                    │
//                                                                    ▼
//                                               POST to admin's URL (signed with secret)
//
// startWebhookWorker()  starts the worker:
//   - Listens to the queue named "webhooks"
//   - For each job it calls deliverWebhook(job.data, ...) which does the
//     real work: sends the POST request to one endpoint
//   - concurrency: 10 means up to 10 deliveries run at the same time
//     (higher than the email worker, because most of the time is spent
//     waiting for the other server to reply)
//   - Uses its own Redis connection from createWorkerRedis()
//
// Retries:
//   If the other server is down or returns an error, the job fails and
//   BullMQ tries again later. deliverWebhook gets two numbers so it knows
//   where it is in the retry process:
//     attempt      which try this is (1 = first try, 2 = first retry, ...)
//     maxAttempts  how many tries are allowed in total
//                  (from the job settings, or WEBHOOK_MAX_ATTEMPTS as the default)
//   After the last attempt fails, it counts as one failure for that endpoint
//   (this is what WebhookEndpoint.failureCount tracks).
//
// requestContext:
//   Each job runs with its requestId, so log lines can be traced back to
//   the original request. If the job has none, it uses "job-<id>".

import { Worker } from "bullmq";
import { createWorkerRedis } from "../config/redis.js";
import { deliverWebhook } from "../modules/webhooks/webhooks.service.js";
import { WEBHOOK_MAX_ATTEMPTS } from "../modules/webhooks/webhooks.constants.js";
import logger, { requestContext } from "../utils/logger.js";

export function startWebhookWorker() {
  const worker = new Worker(
    "webhooks",
    (job) =>
      requestContext.run(
        { requestId: job.data.requestId ?? `job-${job.id}` },
        () =>
          deliverWebhook(job.data, {
            attempt: job.attemptsStarted,
            maxAttempts: job.opts.attempts ?? WEBHOOK_MAX_ATTEMPTS,
          }),
      ),
    { connection: createWorkerRedis(), concurrency: 10 },
  );

  worker.on("completed", (job) =>
    logger.info(`[webhook-worker] delivered ${job.data.event} (${job.id})`),
  );
  worker.on("failed", (job, err) =>
    logger.warn(
      `[webhook-worker] ${job?.data?.event} (${job?.id}) attempt ${job?.attemptsStarted} failed: ${err.message}`,
    ),
  );
  worker.on("error", (err) =>
    logger.error("[webhook-worker] error:", err.message),
  );

  return worker;
}
