import { z } from 'zod';
import { WEBHOOK_EVENTS } from './webhooks.constants.js';

const id = z.uuid('Invalid webhook id');

// at least one known event, duplicates removed
const events = z
  .array(z.enum(WEBHOOK_EVENTS, { error: `events must be from: ${WEBHOOK_EVENTS.join(', ')}` }))
  .min(1, 'Subscribe to at least one event')
  .transform((list) => [...new Set(list)]);

export const createWebhookSchema = z.object({
  body: z.object({
    url: z.url('Invalid URL').max(2048),
    events,
  }),
});

export const updateWebhookSchema = z.object({
  params: z.object({ id }),
  body: z
    .object({ events, active: z.boolean() })
    .partial()
    .refine((b) => Object.keys(b).length > 0, 'Send at least one field to update'),
});

export const webhookIdSchema = z.object({ params: z.object({ id }) });

export const listDeliveriesSchema = z.object({
  params: z.object({ id }),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  }),
});
