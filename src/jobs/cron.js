import cron from 'node-cron';
import prisma from '../config/prisma.js';
import { invalidateEventsCache } from '../utils/cache.js';
import { dispatchWebhook } from '../modules/webhooks/webhooks.service.js';
import { releaseExpiredBookings } from '../modules/bookings/bookings.service.js';
import { processPendingRefunds } from '../modules/payments/payments.service.js';
import logger from '../utils/logger.js';

// Marks every UPCOMING event whose date has passed as FINISHED.
// One UPDATE statement; running it twice is harmless (idempotent).
export async function markFinishedEvents() {
  // Read the ids first: the webhook needs to say WHICH events finished, and
  // updateMany only reports how many. Updating by id also guarantees we announce
  // exactly the events we changed.
  const due = await prisma.event.findMany({
    where: { status: 'UPCOMING', date: { lt: new Date() } },
    select: { id: true, title: true, city: true, date: true },
  });
  if (due.length === 0) return 0;

  const { count } = await prisma.event.updateMany({
    where: { id: { in: due.map((e) => e.id) }, status: 'UPCOMING' },
    data: { status: 'FINISHED' },
  });

  logger.info(`[cron] marked ${count} event(s) as FINISHED`);
  await invalidateEventsCache(); // the events list changed
  await Promise.all(
    due.map((e) => dispatchWebhook('event.finished', { eventId: e.id, title: e.title, city: e.city, date: e.date })),
  );
  return count;
}

// Every minute: give back seats of unpaid bookings whose hold ran out, then refund payments
// that succeeded for bookings that no longer exist (a safety net for refunds that failed earlier).
export async function sweepBookings() {
  const expired = await releaseExpiredBookings();
  const refunds = await processPendingRefunds();
  return { expired, refunds };
}

export function startCron() {
  const finishEvents = () =>
    markFinishedEvents().catch((err) => logger.error('[cron] markFinishedEvents failed:', err.message));
  const sweep = () =>
    sweepBookings().catch((err) => logger.error('[cron] sweepBookings failed:', err.message));

  // catch up immediately on startup (the server may have been down when things became due)
  finishEvents();
  sweep();

  // Format: minute hour day-of-month month day-of-week
  const tasks = [
    cron.schedule('*/10 * * * *', finishEvents, { noOverlap: true }),
    cron.schedule('* * * * *', sweep, { noOverlap: true }),
  ];
  return { stop: () => tasks.forEach((task) => task.stop()) };
}
