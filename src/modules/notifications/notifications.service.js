import Notification from './notification.model.js';
import logger from '../../utils/logger.js';

// Fire-and-forget logging. The booking already succeeded in MySQL, and MySQL and
// MongoDB can NOT share one transaction. So a failed log must never fail the booking:
// we catch and print the error instead of throwing.
export async function notify({ userId, type, message, meta }) {
  try {
    await Notification.create({ userId, type, message, meta });
  } catch (err) {
    logger.error('Failed to save notification:', err.message);
  }
}
