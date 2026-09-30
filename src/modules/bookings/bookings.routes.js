import { Router } from 'express';
import validate from '../../middleware/validate.js';
import requireAuth from '../../middleware/auth.js';
import {
  createBookingSchema,
  bookingIdSchema,
  listMyBookingsSchema,
} from './bookings.schema.js';
import {
  createBooking,
  cancelBooking,
  listMyBookings,
  getBooking,
} from './bookings.controller.js';

const router = Router();

// every booking route needs a logged-in user
router.use(requireAuth);

router.post('/', validate(createBookingSchema), createBooking);
router.get('/me', validate(listMyBookingsSchema), listMyBookings); // must come before '/:id'
router.get('/:id', validate(bookingIdSchema), getBooking);
router.patch('/:id/cancel', validate(bookingIdSchema), cancelBooking);

export default router;
