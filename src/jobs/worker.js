import { Worker } from 'bullmq';
import prisma from '../config/prisma.js';
import { createWorkerRedis } from '../config/redis.js';
import { sendEmail } from '../utils/mailer.js';
import Notification from '../modules/notifications/notification.model.js';
import { describeBookingJob } from './bookingMessages.js';
import logger, { requestContext } from '../utils/logger.js';

// Runs in the background, outside any HTTP request.
// If this function THROWS, BullMQ retries the job (attempts/backoff set in queue.js).
export async function processBookingJob(job) {
  const data = job.data;
  const { type, message, subject } = describeBookingJob(job.name, data);

  // Order matters because a retry re-runs EVERYTHING from the top:
  //  1) the notification log first, as an upsert => running it twice creates one row
  //  2) the email last, because an email cannot be "un-sent" or made idempotent
  // If the email fails, the retry safely repeats step 1 and tries step 2 again.
  await Notification.updateOne(
    { userId: data.userId, type, 'meta.bookingId': data.bookingId },
    {
      $setOnInsert: {
        message,
        meta: { bookingId: data.bookingId, eventId: data.eventId, quantity: data.quantity },
      },
    },
    { upsert: true },
  );

  const user = await prisma.user.findUnique({
    where: { id: data.userId },
    select: { email: true },
  });
  if (!user) return; // user was deleted meanwhile: nothing to email

  await sendEmail({
    to: user.email,
    subject,
    text: `${message}.\nBooking reference: ${data.bookingId}`,
  });
}

export function startWorker() {
  // Re-enter the original request's context, so log lines in this job carry the same ID.
  const processWithContext = (job) =>
    requestContext.run({ requestId: job.data.requestId ?? `job-${job.id}` }, () =>
      processBookingJob(job),
    );

  const worker = new Worker('email', processWithContext, {
    connection: createWorkerRedis(),
    concurrency: 5,
  });

  worker.on('completed', (job) => logger.info(`[worker] done ${job.name} (${job.id})`));
  worker.on('failed', (job, err) =>
    logger.error(`[worker] FAILED ${job?.name} (${job?.id}) attempt ${job?.attemptsMade}:`, err.message),
  );
  worker.on('error', (err) => logger.error('[worker] error:', err.message));

  return worker;
}
