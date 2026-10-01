// This file is the BACKGROUND WORKER. It picks up booking jobs from the
// queue (BullMQ + Redis) and does the slow work: save a notification and
// send an email. Because this happens in the background, the user's
// booking request does not have to wait for it.
//
// The big picture:
//   Booking API ──adds job──► Redis queue ("email") ──► Worker ──► MongoDB + Email
//
// processBookingJob(job)  does the work for ONE job:
//   1. Ask describeBookingJob() for the type, message, and subject
//   2. Save a Notification in MongoDB.
//      It uses "upsert" with $setOnInsert: if the same notification
//      (same user + type + bookingId) already exists, nothing changes.
//      So if a job runs twice (retry, crash), the user does NOT get
//      duplicate notifications.
//   3. Find the user's email in MySQL (Prisma)
//   4. If the user no longer exists, stop (nobody to email)
//   5. Send the email with the subject, message, and booking reference
//
// startWorker()  starts the worker:
//   - Listens to the queue named "email"
//   - concurrency: 5 means up to 5 jobs run at the same time
//   - Uses its own Redis connection from createWorkerRedis()
//   - processWithContext wraps each job with its requestId, so log lines
//     can be traced back to the original request. If the job has no
//     requestId, it uses "job-<id>" instead

import { Worker } from "bullmq";
import prisma from "../config/prisma.js";
import { createWorkerRedis } from "../config/redis.js";
import { sendEmail } from "../utils/mailer.js";
import Notification from "../modules/notifications/notification.model.js";
import { describeBookingJob } from "./bookingMessages.js";
import logger, { requestContext } from "../utils/logger.js";

// code that takes jobs from the queue and runs them
export async function processBookingJob(job) {
  const data = job.data;
  const { type, message, subject } = describeBookingJob(job.name, data);

  await Notification.updateOne(
    { userId: data.userId, type, "meta.bookingId": data.bookingId },
    {
      $setOnInsert: {
        message,
        meta: {
          bookingId: data.bookingId,
          eventId: data.eventId,
          quantity: data.quantity,
        },
      },
    },
    { upsert: true },
  );

  const user = await prisma.user.findUnique({
    where: { id: data.userId },
    select: { email: true },
  });
  if (!user) return;

  await sendEmail({
    to: user.email,
    subject,
    text: `${message}.\nBooking reference: ${data.bookingId}`,
  });
}

export function startWorker() {
  const processWithContext = (job) =>
    requestContext.run(
      { requestId: job.data.requestId ?? `job-${job.id}` },
      () => processBookingJob(job),
    );

  const worker = new Worker("email", processWithContext, {
    connection: createWorkerRedis(), // worker gets its own Redis connection
    concurrency: 5,
  });

  worker.on("completed", (job) =>
    logger.info(`[worker] done ${job.name} (${job.id})`),
  );
  worker.on("failed", (job, err) =>
    logger.error(
      `[worker] FAILED ${job?.name} (${job?.id}) attempt ${job?.attemptsMade}:`,
      err.message,
    ),
  );
  worker.on("error", (err) => logger.error("[worker] error:", err.message));

  return worker;
}
