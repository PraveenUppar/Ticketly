// This file runs SCHEDULED JOBS: small tasks that repeat automatically on a timer,
// without anyone calling an API.
// It has 2 jobs:
//   1. markFinishedEvents()   runs every 10 minutes
//      - Finds events that are still UPCOMING but whose date has already passed
//      - Changes their status to FINISHED
//      - Clears the events cache (the events list changed, so old cached copies are wrong)
//      - Sends an "event.finished" webhook for each one, so admins' URLs get notified
//      - Returns how many events were changed (0 if nothing was due)
//      - The update uses "status: UPCOMING" again as a safety check, so an event
//        changed by someone else in the meantime is not touched twice
//
//   2. sweepBookings()        runs every minute
//      - releaseExpiredBookings(): finds bookings still waiting for payment after
//        BOOKING_HOLD_MINUTES, marks them EXPIRED, and gives the held seats back
//      - processPendingRefunds(): handles payments in REFUND_PENDING status
//        by asking the payment provider to refund them
//      - Returns how many of each it handled
//
// startCron()  starts both timers:
//   - Runs each job once immediately at startup, so work missed while the
//     server was off is caught up right away
//   - Then schedules them with these patterns:
//       "*/10 * * * *"   every 10 minutes
//       "* * * * *"      every minute
//   - noOverlap: true means if the previous run is still going, skip the next one,
//     so two runs never work on the same data at the same time
//   - Errors are caught and logged, so one failure does not crash the server
//     or stop the timer
//   - Returns { stop() } so you can cancel the timers when the server shuts down
//     or at the end of tests

import cron from "node-cron";
import prisma from "../config/prisma.js";
import { invalidateEventsCache } from "../utils/cache.js";
import { dispatchWebhook } from "../modules/webhooks/webhooks.service.js";
import { releaseExpiredBookings } from "../modules/bookings/bookings.service.js";
import { processPendingRefunds } from "../modules/payments/payments.service.js";
import logger from "../utils/logger.js";

export async function markFinishedEvents() {
  const due = await prisma.event.findMany({
    where: { status: "UPCOMING", date: { lt: new Date() } },
    select: { id: true, title: true, city: true, date: true },
  });
  if (due.length === 0) return 0;

  const { count } = await prisma.event.updateMany({
    where: { id: { in: due.map((e) => e.id) }, status: "UPCOMING" },
    data: { status: "FINISHED" },
  });

  logger.info(`[cron] marked ${count} event(s) as FINISHED`);
  await invalidateEventsCache();
  await Promise.all(
    due.map((e) =>
      dispatchWebhook("event.finished", {
        eventId: e.id,
        title: e.title,
        city: e.city,
        date: e.date,
      }),
    ),
  );
  return count;
}

export async function sweepBookings() {
  const expired = await releaseExpiredBookings();
  const refunds = await processPendingRefunds();
  return { expired, refunds };
}

export function startCron() {
  const finishEvents = () =>
    markFinishedEvents().catch((err) =>
      logger.error("[cron] markFinishedEvents failed:", err.message),
    );
  const sweep = () =>
    sweepBookings().catch((err) =>
      logger.error("[cron] sweepBookings failed:", err.message),
    );

  finishEvents();
  sweep();

  const tasks = [
    cron.schedule("*/10 * * * *", finishEvents, { noOverlap: true }),
    cron.schedule("* * * * *", sweep, { noOverlap: true }),
  ];
  return { stop: () => tasks.forEach((task) => task.stop()) };
}
