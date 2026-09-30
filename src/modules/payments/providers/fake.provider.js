import crypto from 'node:crypto';
import { z } from 'zod';
import AppError from '../../../utils/AppError.js';
import { signPayload, verifySignature } from '../../webhooks/webhooks.security.js';

// A stand-in for Razorpay / Stripe. No account, no network, no money.
// It implements the SAME interface a real provider adapter must implement, so swapping in a
// real one later only touches this folder:
//
//   name
//   createOrder({ bookingId, amountMinor, currency })  -> { providerOrderId, clientPayload }
//   refund({ providerPaymentId, amountMinor, idempotencyKey }) -> { providerRefundId }
//   verifyWebhook({ rawBody, headers })  -> { id, type, data }   (throws AppError if not genuine)
//
// Normalised event types the rest of the app understands:
//   payment.succeeded | payment.failed | refund.processed
const eventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.object({
    orderId: z.string().min(1),
    paymentId: z.string().min(1).optional(),
    amountMinor: z.number().int().optional(),
    currency: z.string().optional(),
  }),
});

export function createFakeProvider({ webhookSecret }) {
  return {
    name: 'fake',

    async createOrder({ amountMinor, currency }) {
      const providerOrderId = `order_fake_${crypto.randomBytes(8).toString('hex')}`;
      return {
        providerOrderId,
        // What a real provider gives the browser/app so it can open its checkout.
        clientPayload: {
          provider: 'fake',
          orderId: providerOrderId,
          amountMinor,
          currency,
          hint: 'Fake provider: call POST /api/dev/fake-provider/events to simulate the payment.',
        },
      };
    },

    // The refund id is derived from the idempotency key: asking twice for the same refund gives
    // the same result, like a real provider that honours idempotency keys.
    async refund({ idempotencyKey }) {
      const digest = crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16);
      return { providerRefundId: `rf_fake_${digest}` };
    },

    // What the real webhook route runs on every incoming call.
    verifyWebhook({ rawBody, headers }) {
      const genuine = verifySignature({
        secret: webhookSecret,
        timestamp: headers['x-fake-timestamp'],
        body: rawBody,
        signature: headers['x-fake-signature'],
      });
      if (!genuine) throw new AppError('Invalid webhook signature', 401);

      let json;
      try {
        json = JSON.parse(rawBody);
      } catch {
        throw new AppError('Webhook body is not valid JSON', 400);
      }
      const parsed = eventSchema.safeParse(json);
      if (!parsed.success) throw new AppError('Webhook body has an unexpected shape', 400);
      return parsed.data;
    },

    // Test/dev helper (a real provider does this on its own servers): produce a signed delivery.
    signEvent(event, { timestamp = String(Math.floor(Date.now() / 1000)) } = {}) {
      const rawBody = JSON.stringify(event);
      return {
        rawBody,
        headers: {
          'x-fake-timestamp': timestamp,
          'x-fake-signature': signPayload(webhookSecret, timestamp, rawBody),
        },
      };
    },
  };
}
