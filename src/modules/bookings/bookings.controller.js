import AppError from '../../utils/AppError.js';
import asyncHandler from '../../utils/asyncHandler.js';
import logger from '../../utils/logger.js';
import * as bookings from './bookings.service.js';
import { announceSeats, announceConfirmed, announceCancelled } from './bookings.events.js';
import { createPaymentForBooking, refundIfPaid } from '../payments/payments.service.js';

export const createBooking = asyncHandler(async (req, res) => {
  const { eventId, quantity } = req.validated.body;
  const { booking, seatsLeft, eventTitle } = await bookings.createBooking({
    userId: req.user.id,
    eventId,
    quantity,
  });

  // The MySQL transaction is committed. Seats are held either way, so the cached list is stale
  // and everyone watching this event should see the new count.
  await announceSeats(eventId, seatsLeft);

  // FREE event: nothing to pay, the booking is already CONFIRMED.
  if (booking.status === 'CONFIRMED') {
    await announceConfirmed({ booking, eventTitle, seatsLeft });
    return res.status(201).json({ status: 'success', data: { booking, seatsLeft, payment: null } });
  }

  // PAID event: the booking is PENDING_PAYMENT. Create the order at the payment provider.
  // It is confirmed later, by the provider's webhook (see modules/payments/payments.webhook.js).
  let created;
  try {
    created = await createPaymentForBooking(booking);
  } catch (err) {
    // Compensation: the seats were reserved but we cannot take payment, so give them back
    // instead of holding them for 15 minutes for nothing.
    logger.error('[bookings] could not create the payment order:', err.message);
    const released = await bookings.releasePendingBooking(booking.id, { status: 'CANCELLED' });
    if (released) await announceSeats(eventId, released.seatsLeft);
    throw new AppError('Payment is unavailable right now, please try again', 502);
  }

  res.status(201).json({
    status: 'success',
    data: {
      booking,
      seatsLeft,
      payment: {
        status: created.payment.status,
        orderId: created.payment.providerOrderId,
        amountMinor: created.payment.amountMinor,
        currency: created.payment.currency,
        expiresAt: booking.expiresAt, // pay before this or the seats are released
        checkout: created.clientPayload, // what the frontend hands to the provider's checkout
      },
    },
  });
});

export const cancelBooking = asyncHandler(async (req, res) => {
  const { booking, seatsLeft, eventTitle } = await bookings.cancelBooking({
    bookingId: req.validated.params.id,
    user: req.user,
  });

  await announceSeats(booking.eventId, seatsLeft);
  // If the booking had been paid, the money goes back. Best effort: a failure is retried by
  // the sweep in jobs/cron.js, and must not turn this successful cancel into an error.
  await refundIfPaid(booking.id);
  await announceCancelled({ booking, eventTitle, seatsLeft });

  res.json({ status: 'success', data: { booking, seatsLeft } });
});

export const listMyBookings = asyncHandler(async (req, res) => {
  const { page, limit } = req.validated.query;
  const { bookings: items, total } = await bookings.listMyBookings({
    userId: req.user.id,
    page,
    limit,
  });
  res.json({
    status: 'success',
    data: { bookings: items },
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

export const getBooking = asyncHandler(async (req, res) => {
  const booking = await bookings.getBooking({
    bookingId: req.validated.params.id,
    user: req.user,
  });
  res.json({ status: 'success', data: { booking } });
});
