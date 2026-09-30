import { z } from 'zod';

const id = z.uuid('Invalid id');

export const createBookingSchema = z.object({
  body: z.object({
    eventId: id,
    quantity: z.coerce.number().int().min(1).max(10),
  }),
});

export const bookingIdSchema = z.object({ params: z.object({ id }) });

export const listMyBookingsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  }),
});
