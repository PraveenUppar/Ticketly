import AppError from '../../utils/AppError.js';
import asyncHandler from '../../utils/asyncHandler.js';
import Notification from './notification.model.js';

export const listMyNotifications = asyncHandler(async (req, res) => {
  const { page, limit, unread } = req.validated.query;

  const filter = { userId: req.user.id, ...(unread === 'true' && { read: false }) };

  const [notifications, total] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Notification.countDocuments(filter),
  ]);

  res.json({
    status: 'success',
    data: { notifications },
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

export const markRead = asyncHandler(async (req, res) => {
  // userId is part of the filter, so nobody can mark someone else's notification.
  const notification = await Notification.findOneAndUpdate(
    { _id: req.validated.params.id, userId: req.user.id },
    { read: true },
    { new: true },
  );
  if (!notification) throw new AppError('Notification not found', 404);
  res.json({ status: 'success', data: { notification } });
});
