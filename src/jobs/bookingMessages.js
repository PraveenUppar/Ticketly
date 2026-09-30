// One place that decides what a booking job means, shared by the worker
// and by the direct fallback in queue.js (used when Redis is down).
export function describeBookingJob(name, { quantity, eventTitle }) {
  switch (name) {
    case 'booking-confirmed':
      return {
        type: 'BOOKING_CONFIRMED',
        subject: `Booking confirmed: ${eventTitle}`,
        message: `Booking confirmed: ${quantity} seat(s) for ${eventTitle}`,
      };
    case 'booking-cancelled':
      return {
        type: 'BOOKING_CANCELLED',
        subject: `Booking cancelled: ${eventTitle}`,
        message: `Booking cancelled: ${quantity} seat(s) for ${eventTitle}`,
      };
    case 'booking-expired':
      return {
        type: 'BOOKING_EXPIRED',
        subject: `Booking expired: ${eventTitle}`,
        message: `Payment was not completed in time, so ${quantity} seat(s) for ${eventTitle} were released`,
      };
    default:
      throw new Error(`Unknown booking job: ${name}`);
  }
}
