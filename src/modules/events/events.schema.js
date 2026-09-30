import { z } from 'zod';

const id = z.uuid('Invalid event id');

export const createEventSchema = z.object({
  body: z.object({
    title: z.string().trim().min(3).max(150),
    description: z.string().trim().max(5000).optional(),
    city: z.string().trim().min(2).max(100),
    date: z.coerce.date().refine((d) => d > new Date(), 'Event date must be in the future'),
    price: z.coerce.number().min(0).max(1_000_000),
    totalSeats: z.coerce.number().int().min(1).max(100_000),
  }),
});

// totalSeats is deliberately NOT editable here: changing it would have to
// stay consistent with seatsLeft and existing bookings (see Day 4).
export const updateEventSchema = z.object({
  params: z.object({ id }),
  body: z
    .object({
      title: z.string().trim().min(3).max(150),
      description: z.string().trim().max(5000).nullable(),
      city: z.string().trim().min(2).max(100),
      date: z.coerce.date().refine((d) => d > new Date(), 'Event date must be in the future'),
      price: z.coerce.number().min(0).max(1_000_000),
    })
    .partial()
    .refine((b) => Object.keys(b).length > 0, 'Send at least one field to update'),
});

export const eventIdSchema = z.object({ params: z.object({ id }) });

// Query params always arrive as strings, so numbers use z.coerce.
export const listEventsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
    city: z.string().trim().min(1).optional(),
    q: z.string().trim().min(1).optional(),
    // "-" prefix = descending, e.g. sort=-price
    sort: z.enum(['date', '-date', 'price', '-price', 'createdAt', '-createdAt']).default('date'),
  }),
});
