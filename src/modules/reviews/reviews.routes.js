import { Router } from 'express';
import validate from '../../middleware/validate.js';
import requireAuth from '../../middleware/auth.js';
import { createReviewSchema, listReviewsSchema, reviewIdSchema } from './reviews.schema.js';
import { createReview, listReviews, deleteReview } from './reviews.controller.js';

// Mounted at /api so both URL shapes live in one file.
const router = Router();

router.get('/events/:eventId/reviews', validate(listReviewsSchema), listReviews);
router.post('/events/:eventId/reviews', requireAuth, validate(createReviewSchema), createReview);
router.delete('/reviews/:id', requireAuth, validate(reviewIdSchema), deleteReview);

export default router;
