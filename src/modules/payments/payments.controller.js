import { randomBytes, randomUUID } from 'node:crypto';
import prisma from '../../config/prisma.js';
import AppError from '../../utils/AppError.js';
import asyncHandler from '../../utils/asyncHandler.js';
import { paymentProvider } from './providers/index.js';
import { processIncomingWebhook } from './payments.webhook.js';

// PUBLIC route: the payment provider calls it, so there is no JWT. The signature IS the login.
// app.js mounts express.raw() for this path BEFORE express.json(), so req.body is the exact
// bytes the provider sent. The signature is computed over those bytes, so we must not parse
// and re-serialise them first.
export const receiveWebhook = asyncHandler(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw new AppError('Empty webhook body', 400);
  }

  const { result } = await processIncomingWebhook({
    rawBody: req.body.toString('utf8'),
    headers: req.headers,
  });

  // Any 2xx tells the provider "got it, stop retrying". Errors thrown above become 4xx/5xx.
  res.json({ received: true, result });
});

// DEV ONLY (mounted only with the fake provider): plays the part of the payment provider.
// It builds a properly signed event and feeds it into the SAME processIncomingWebhook the real
// route uses, so the whole flow can be tried without any external account.
export const simulateProviderEvent = asyncHandler(async (req, res) => {
  const { type, orderId } = req.validated.body;

  const payment = await prisma.payment.findUnique({
    where: { providerOrderId: orderId },
    include: { booking: { select: { userId: true } } },
  });
  if (!payment) throw new AppError('Order not found', 404);
  if (payment.booking.userId !== req.user.id && req.user.role !== 'ADMIN') {
    throw new AppError('This order belongs to someone else', 403);
  }

  const event = {
    id: `evt_fake_${randomUUID()}`,
    type,
    data: {
      orderId,
      paymentId: payment.providerPaymentId ?? `pay_fake_${randomBytes(6).toString('hex')}`,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
    },
  };

  const { result } = await processIncomingWebhook(paymentProvider.signEvent(event));
  res.json({ status: 'success', data: { eventId: event.id, result } });
});
