import prisma from '../../config/prisma.js';
import logger from '../../utils/logger.js';
import { paymentProvider } from './providers/index.js';
import { refundIfPaid } from './payments.service.js';
import { announceConfirmed } from '../bookings/bookings.events.js';

// ---------------------------------------------------------------------------
// The single entry point for everything the payment provider tells us.
//
//   1. VERIFY   the signature (over the raw body). Not genuine -> 401, nothing else happens.
//   2. DEDUPE   store the event id in an inbox table. Providers deliver "at least once", so
//               the same event can arrive twice. A duplicate is acknowledged and ignored.
//   3. APPLY    change our data. Every change is a conditional update ("only if it is still
//               in state X"), so repeating or reordering events cannot corrupt anything.
//   4. ACK      return normally -> the route answers 2xx. If step 3 THROWS we answer 5xx,
//               and the provider retries later (the inbox row is unfinished, so it re-runs).
// ---------------------------------------------------------------------------
export async function processIncomingWebhook({ rawBody, headers }, { provider = paymentProvider } = {}) {
  const event = provider.verifyWebhook({ rawBody, headers });

  let inbox;
  try {
    inbox = await prisma.paymentWebhookEvent.create({
      data: { provider: provider.name, providerEventId: event.id, type: event.type, payload: event },
    });
  } catch (err) {
    if (err.code !== 'P2002') throw err; // not a duplicate: a real problem
    inbox = await prisma.paymentWebhookEvent.findUnique({
      where: { provider_providerEventId: { provider: provider.name, providerEventId: event.id } },
    });
    if (inbox.processedAt) return { result: 'duplicate' }; // already handled: acknowledge, do nothing
    // else: an earlier attempt received it but failed midway: run it again (safe, see step 3)
  }

  const result = await applyEvent(event);

  await prisma.paymentWebhookEvent.update({
    where: { id: inbox.id },
    data: { processedAt: new Date(), result },
  });
  return { result };
}

async function applyEvent(event) {
  switch (event.type) {
    case 'payment.succeeded':
      return onPaymentSucceeded(event.data);
    case 'payment.failed':
      return onPaymentFailed(event.data);
    case 'refund.processed':
      return onRefundProcessed(event.data);
    default:
      return 'ignored'; // event types we don't use are acknowledged so the provider stops retrying
  }
}

async function onPaymentSucceeded({ orderId, paymentId, amountMinor, currency }) {
  const payment = await prisma.payment.findUnique({ where: { providerOrderId: orderId } });
  if (!payment) return 'unknown-order';

  // Never trust that the right amount was paid: compare with what WE stored at booking time.
  // A mismatch is not confirmed, and is loudly logged for a human to look at.
  if (
    (amountMinor !== undefined && amountMinor !== payment.amountMinor) ||
    (currency !== undefined && currency !== payment.currency)
  ) {
    logger.error(
      `[payments] AMOUNT MISMATCH on order ${orderId}: expected ${payment.amountMinor} ${payment.currency}, got ${amountMinor} ${currency}`,
    );
    return 'amount-mismatch';
  }

  const outcome = await prisma.$transaction(async (tx) => {
    // Step 1: mark the payment as received. Matches only if it isn't SUCCEEDED (or later) yet,
    // so a repeated event stops right here.
    const marked = await tx.payment.updateMany({
      where: { id: payment.id, status: { in: ['CREATED', 'FAILED'] } },
      data: { status: 'SUCCEEDED', providerPaymentId: paymentId },
    });
    if (marked.count === 0) return 'already-processed';

    // Step 2: confirm the booking, but ONLY if it is still waiting for this payment.
    // If the hold expired or the user cancelled meanwhile, this matches nothing.
    const confirmed = await tx.booking.updateMany({
      where: { id: payment.bookingId, status: 'PENDING_PAYMENT' },
      data: { status: 'CONFIRMED', expiresAt: null },
    });
    return confirmed.count === 1 ? 'confirmed' : 'late-payment';
  });

  if (outcome === 'confirmed') {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: payment.bookingId },
        include: { event: { select: { title: true, seatsLeft: true } } },
      });
      await announceConfirmed({
        booking,
        eventTitle: booking.event.title,
        seatsLeft: booking.event.seatsLeft,
      });
    } catch (err) {
      logger.error('[payments] booking confirmed but follow-ups failed:', err.message);
    }
  }

  if (outcome === 'late-payment') {
    // Money arrived for a booking that no longer exists (expired or cancelled, seats already
    // given away). We can't honour it, so it goes straight back.
    logger.warn(`[payments] payment for order ${orderId} arrived after its booking ended: refunding`);
    await refundIfPaid(payment.bookingId);
  }

  return outcome;
}

async function onPaymentFailed({ orderId }) {
  const payment = await prisma.payment.findUnique({ where: { providerOrderId: orderId } });
  if (!payment) return 'unknown-order';

  // Only CREATED -> FAILED. The booking keeps holding its seats until it expires, and the user
  // may try again on the same order (a later payment.succeeded moves FAILED -> SUCCEEDED).
  await prisma.payment.updateMany({
    where: { id: payment.id, status: 'CREATED' },
    data: { status: 'FAILED' },
  });
  return 'payment-failed';
}

async function onRefundProcessed({ orderId }) {
  const payment = await prisma.payment.findUnique({ where: { providerOrderId: orderId } });
  if (!payment) return 'unknown-order';

  const done = await prisma.payment.updateMany({
    where: { id: payment.id, status: 'REFUND_PENDING' },
    data: { status: 'REFUNDED' },
  });
  return done.count === 1 ? 'refunded' : 'ignored';
}
