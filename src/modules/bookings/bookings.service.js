import prisma from '../../config/prisma.js';
import AppError from '../../utils/AppError.js';
import logger from '../../utils/logger.js';
import { BOOKING_HOLD_MINUTES, CURRENCY } from '../../config/env.js';
import { announceSeats, announceExpired } from './bookings.events.js';

// Interactive transactions wait for a pooled connection; give them a bit more room
// than the defaults (2s / 5s) so a burst of bookings doesn't fail spuriously.
const TX_OPTIONS = { maxWait: 5000, timeout: 10000 };

// Statuses in which a booking is holding seats.
const HOLDING = ['PENDING_PAYMENT', 'CONFIRMED'];

const eventSummary = { id: true, title: true, city: true, date: true, price: true };
const paymentSummary = { status: true, providerOrderId: true, amountMinor: true, currency: true };

// Price in minor units (paise/cents) as an integer. Decimal(10,2) has at most 2 decimals,
// so this is exact. Money is never handled as a float beyond this one conversion.
const toMinorUnits = (price) => Math.round(Number(price) * 100);

export async function createBooking({ userId, eventId, quantity }) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId } });
    if (!event) throw new AppError('Event not found', 404);
    if (event.status !== 'UPCOMING' || event.date <= new Date()) {
      throw new AppError('This event is no longer open for booking', 400);
    }

    // THE IMPORTANT LINE. "Check seats, then subtract" as two steps is a race:
    // two requests both read seatsLeft = 1, both pass the check, both book.
    // Instead we do check + subtract as ONE atomic statement:
    //   UPDATE Event SET seatsLeft = seatsLeft - ? WHERE id = ? AND seatsLeft >= ?
    // MySQL row-locks the event for this statement, so requests queue up one by one.
    // count === 0 means the WHERE failed, i.e. not enough seats.
    const reserved = await tx.event.updateMany({
      where: { id: eventId, seatsLeft: { gte: quantity } },
      data: { seatsLeft: { decrement: quantity } },
    });
    if (reserved.count === 0) throw new AppError('Not enough seats available', 409);

    // A paid event starts as PENDING_PAYMENT: the seats are held for a while, and only the
    // payment webhook can make the booking CONFIRMED. A free event is confirmed straight away.
    // The amount is copied onto the booking now, so a later price edit cannot change it.
    const amountMinor = toMinorUnits(event.price) * quantity;
    const requiresPayment = amountMinor > 0;

    const booking = await tx.booking.create({
      data: {
        userId,
        eventId,
        quantity,
        amountMinor,
        currency: CURRENCY,
        status: requiresPayment ? 'PENDING_PAYMENT' : 'CONFIRMED',
        expiresAt: requiresPayment ? new Date(Date.now() + BOOKING_HOLD_MINUTES * 60_000) : null,
      },
    });
    const { seatsLeft } = await tx.event.findUnique({
      where: { id: eventId },
      select: { seatsLeft: true },
    });

    // If ANYTHING above throws, the whole transaction rolls back and the seats come back.
    return { booking, seatsLeft, eventTitle: event.title };
  }, TX_OPTIONS);
}

// Gives the seats of a PENDING_PAYMENT booking back and sets its final status.
// Used when creating the payment order failed (CANCELLED) and when the hold ran out (EXPIRED).
// Returns null if the booking was no longer pending (e.g. the payment arrived in the meantime).
export async function releasePendingBooking(bookingId, { status, onlyIfExpired = false }) {
  return prisma.$transaction(async (tx) => {
    // Atomic flip, same idea as cancel: only ONE caller can move it out of PENDING_PAYMENT,
    // so the seats can never be given back twice, and never after a payment confirmed it.
    const flipped = await tx.booking.updateMany({
      where: {
        id: bookingId,
        status: 'PENDING_PAYMENT',
        ...(onlyIfExpired && { expiresAt: { lt: new Date() } }),
      },
      data: { status, expiresAt: null },
    });
    if (flipped.count === 0) return null;

    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: { event: { select: { title: true } } },
    });
    const event = await tx.event.update({
      where: { id: booking.eventId },
      data: { seatsLeft: { increment: booking.quantity } },
      select: { seatsLeft: true },
    });

    return { booking, seatsLeft: event.seatsLeft, eventTitle: booking.event.title };
  }, TX_OPTIONS);
}

// Runs every minute (see jobs/cron.js): unpaid holds past their expiry give the seats back.
export async function releaseExpiredBookings() {
  const due = await prisma.booking.findMany({
    where: { status: 'PENDING_PAYMENT', expiresAt: { lt: new Date() } },
    select: { id: true },
    take: 100,
  });

  let released = 0;
  for (const { id } of due) {
    try {
      const result = await releasePendingBooking(id, { status: 'EXPIRED', onlyIfExpired: true });
      if (!result) continue; // paid or cancelled in the meantime
      released++;
      await announceSeats(result.booking.eventId, result.seatsLeft);
      await announceExpired(result);
    } catch (err) {
      logger.error(`[bookings] could not release expired booking ${id}:`, err.message);
    }
  }
  if (released > 0) logger.info(`[bookings] released ${released} expired booking(s)`);
  return released;
}

export async function cancelBooking({ bookingId, user }) {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: { event: { select: { date: true, title: true } } },
    });
    if (!booking) throw new AppError('Booking not found', 404);

    // Ownership: a user may only cancel their own booking (admins may cancel any).
    if (booking.userId !== user.id && user.role !== 'ADMIN') {
      throw new AppError('You can only cancel your own bookings', 403);
    }
    if (booking.event.date <= new Date()) {
      throw new AppError('Cannot cancel a booking for an event that has started', 400);
    }

    // Atomic status flip: only ONE concurrent cancel can match. Without this, a double-click
    // could give the seats back twice. A booking still waiting for payment can be cancelled too.
    const flipped = await tx.booking.updateMany({
      where: { id: bookingId, status: { in: HOLDING } },
      data: { status: 'CANCELLED', expiresAt: null },
    });
    if (flipped.count === 0) throw new AppError('Booking is already cancelled or expired', 409);

    const event = await tx.event.update({
      where: { id: booking.eventId },
      data: { seatsLeft: { increment: booking.quantity } },
      select: { seatsLeft: true },
    });

    return {
      booking: { ...booking, event: undefined, status: 'CANCELLED', expiresAt: null },
      previousStatus: booking.status,
      seatsLeft: event.seatsLeft,
      eventId: booking.eventId,
      eventTitle: booking.event.title,
    };
  }, TX_OPTIONS);
}

export async function listMyBookings({ userId, page, limit }) {
  const where = { userId };
  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: { event: { select: eventSummary }, payment: { select: paymentSummary } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.booking.count({ where }),
  ]);
  return { bookings, total };
}

export async function getBooking({ bookingId, user }) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { event: { select: eventSummary }, payment: { select: paymentSummary } },
  });
  if (!booking) throw new AppError('Booking not found', 404);
  if (booking.userId !== user.id && user.role !== 'ADMIN') {
    throw new AppError('You can only view your own bookings', 403);
  }
  return booking;
}
