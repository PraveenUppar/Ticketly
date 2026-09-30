import { z } from 'zod';

// Dev-only: which provider event to simulate for an order.
export const simulateEventSchema = z.object({
  body: z.object({
    type: z.enum(['payment.succeeded', 'payment.failed', 'refund.processed']),
    orderId: z.string().min(1),
  }),
});
