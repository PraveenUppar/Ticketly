import { z } from 'zod';

const eventId = z.uuid('Invalid event id');
// MongoDB ids are 24 hex characters. Validating here avoids a mongoose CastError (a 500).
const reviewId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid review id');

export const createReviewSchema = z.object({
  params: z.object({ eventId }),
  body: z.object({
    rating: z.coerce.number().int().min(1).max(5),
    comment: z.string().trim().max(1000).optional(),
  }),
});

export const listReviewsSchema = z.object({
  params: z.object({ eventId }),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  }),
});

export const reviewIdSchema = z.object({ params: z.object({ id: reviewId }) });
