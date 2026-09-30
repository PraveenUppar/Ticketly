import prisma from '../../config/prisma.js';
import logger from '../../utils/logger.js';
import { paymentProvider } from './providers/index.js';

// Called right after a PENDING_PAYMENT booking was committed. Talks to the provider over the
// network, which is why it is NOT done inside the booking transaction: a slow or failing
// provider must never hold database locks. The caller compensates (releases the seats) if this throws.
export async function createPaymentForBooking(booking, { provider = paymentProvider } = {}) {
  const { providerOrderId, clientPayload } = await provider.createOrder({
    bookingId: booking.id,
    amountMinor: booking.amountMinor,
    currency: booking.currency,
  });

  const payment = await prisma.payment.create({
    data: {
      bookingId: booking.id,
      provider: provider.name,
      providerOrderId,
      amountMinor: booking.amountMinor,
      currency: booking.currency,
    },
  });
  return { payment, clientPayload };
}

// Rule: a payment that SUCCEEDED but whose booking is CANCELLED or EXPIRED must be refunded.
// This function is safe to call from anywhere, any number of times:
//   - it never touches a live (pending or confirmed) booking
//   - it claims the payment with an atomic SUCCEEDED -> REFUND_PENDING flip, so two callers
//     can't both refund
//   - the provider call carries an idempotency key, so a retry can't refund twice there either
export async function requestRefund(paymentId, { provider = paymentProvider } = {}) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { booking: { select: { status: true } } },
  });
  if (!payment || payment.status !== 'SUCCEEDED') return 'skipped';
  if (!['CANCELLED', 'EXPIRED'].includes(payment.booking.status)) return 'skipped';

  const claimed = await prisma.payment.updateMany({
    where: { id: paymentId, status: 'SUCCEEDED' },
    data: { status: 'REFUND_PENDING' },
  });
  if (claimed.count === 0) return 'skipped'; // someone else is already refunding it

  try {
    const { providerRefundId } = await provider.refund({
      providerPaymentId: payment.providerPaymentId,
      amountMinor: payment.amountMinor,
      idempotencyKey: `refund-${payment.id}`,
    });
    await prisma.payment.update({ where: { id: paymentId }, data: { providerRefundId } });
    return 'requested';
  } catch (err) {
    // Put it back so the sweep below retries it later.
    await prisma.payment.updateMany({
      where: { id: paymentId, status: 'REFUND_PENDING' },
      data: { status: 'SUCCEEDED' },
    });
    throw err;
  }
}

// Best-effort refund for a booking that has just been cancelled or found to be late.
// A failure is logged, not thrown: the sweep will retry it, and the user's request has succeeded.
export async function refundIfPaid(bookingId, options) {
  try {
    const payment = await prisma.payment.findUnique({ where: { bookingId } });
    if (payment?.status === 'SUCCEEDED') return await requestRefund(payment.id, options);
    return 'skipped';
  } catch (err) {
    logger.error(`[payments] refund for booking ${bookingId} failed, the sweep will retry:`, err.message);
    return 'failed';
  }
}

// Safety net that runs every minute (see jobs/cron.js): finds paid-but-dead bookings whose
// refund never happened (provider was down, process crashed) and refunds them.
export async function processPendingRefunds(options) {
  const stuck = await prisma.payment.findMany({
    where: { status: 'SUCCEEDED', booking: { status: { in: ['CANCELLED', 'EXPIRED'] } } },
    select: { id: true },
    take: 50,
  });

  let requested = 0;
  for (const { id } of stuck) {
    try {
      if ((await requestRefund(id, options)) === 'requested') requested++;
    } catch (err) {
      logger.error(`[payments] refund retry for payment ${id} failed:`, err.message);
    }
  }
  return requested;
}
