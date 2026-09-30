import prisma from '../../config/prisma.js';
import AppError from '../../utils/AppError.js';
import asyncHandler from '../../utils/asyncHandler.js';
import Review from './review.model.js';

export const createReview = asyncHandler(async (req, res) => {
  const { eventId } = req.validated.params;
  const { rating, comment } = req.validated.body;
  const userId = req.user.id;

  // CROSS-DATABASE CHECK. The event lives in MySQL, the review in MongoDB, and
  // MongoDB can't verify an eventId. So we ask MySQL ourselves BEFORE saving.
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true } });
  if (!event) throw new AppError('Event not found', 404);

  // Business rule: only people who actually booked the event can review it.
  // Because events with bookings can never be deleted (Day 3), a review can't
  // end up pointing at an event that no longer exists.
  const booking = await prisma.booking.findFirst({
    where: { eventId, userId, status: 'CONFIRMED' },
    select: { id: true },
  });
  if (!booking) throw new AppError('You can only review events you have booked', 403);

  try {
    const review = await Review.create({ eventId, userId, rating, comment });
    res.status(201).json({ status: 'success', data: { review } });
  } catch (err) {
    // 11000 = duplicate key: our unique {eventId, userId} index caught a second review.
    if (err.code === 11000) throw new AppError('You have already reviewed this event', 409);
    throw err;
  }
});

export const listReviews = asyncHandler(async (req, res) => {
  const { eventId } = req.validated.params;
  const { page, limit } = req.validated.query;

  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true } });
  if (!event) throw new AppError('Event not found', 404);

  const [reviews, stats] = await Promise.all([
    Review.find({ eventId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    // Aggregation pipeline: filter to this event, then average the ratings.
    Review.aggregate([
      { $match: { eventId } },
      { $group: { _id: null, avgRating: { $avg: '$rating' }, total: { $sum: 1 } } },
    ]),
  ]);

  const total = stats[0]?.total ?? 0;
  const avgRating = stats[0] ? Math.round(stats[0].avgRating * 10) / 10 : null;

  res.json({
    status: 'success',
    data: { reviews },
    meta: { page, limit, total, totalPages: Math.ceil(total / limit), avgRating },
  });
});

export const deleteReview = asyncHandler(async (req, res) => {
  const review = await Review.findById(req.validated.params.id);
  if (!review) throw new AppError('Review not found', 404);

  if (review.userId !== req.user.id && req.user.role !== 'ADMIN') {
    throw new AppError('You can only delete your own reviews', 403);
  }

  await review.deleteOne();
  res.status(204).send();
});
