import { addBookingJob } from '../../jobs/queue.js';
import { invalidateEventsCache } from '../../utils/cache.js';
import { emitSeatsUpdate } from '../../sockets/index.js';
import { dispatchWebhook } from '../webhooks/webhooks.service.js';

// Everything that must happen AFTER a booking change has been committed to MySQL.
// Grouped here because several places trigger the same follow-ups: the booking controller,
// the payment webhook handler and the expiry job. None of these functions throw: the database
// change is already final, so a failing side effect must never undo or fail it.

// Seats were reserved or released: the cached list is stale, and watchers get the new count.
export async function announceSeats(eventId, seatsLeft) {
  await invalidateEventsCache();
  emitSeatsUpdate(eventId, seatsLeft);
}

const payloadOf = ({ booking, eventTitle }) => ({
  userId: booking.userId,
  bookingId: booking.id,
  eventId: booking.eventId,
  eventTitle,
  quantity: booking.quantity,
});

// Email job and outgoing webhook are independent, so they run side by side (each has its own
// queue deadline, so a Redis outage costs one wait, not two).
export async function announceConfirmed({ booking, eventTitle, seatsLeft }) {
  const data = payloadOf({ booking, eventTitle });
  await Promise.all([
    addBookingJob('booking-confirmed', data),
    dispatchWebhook('booking.confirmed', { ...data, seatsLeft }),
  ]);
}

export async function announceCancelled({ booking, eventTitle, seatsLeft }) {
  const data = payloadOf({ booking, eventTitle }); // userId = the booking's owner, even if an admin cancelled it
  await Promise.all([
    addBookingJob('booking-cancelled', data),
    dispatchWebhook('booking.cancelled', { ...data, seatsLeft }),
  ]);
}

export async function announceExpired({ booking, eventTitle, seatsLeft }) {
  const data = payloadOf({ booking, eventTitle });
  await Promise.all([
    addBookingJob('booking-expired', data),
    dispatchWebhook('booking.expired', { ...data, seatsLeft }),
  ]);
}
