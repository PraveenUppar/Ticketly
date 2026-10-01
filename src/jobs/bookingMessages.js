// This file decides what each booking job MEANS: which notification type,
// email subject, and message text to use.
// //
// Who uses it:
//   - The worker (when Redis is working and jobs run in the background)
//   - The fallback in queue.js (when Redis is down and the job runs directly)
// Both call this same function, so users get the same message either way.

// The 3 job names it understands:
//   booking-confirmed   type BOOKING_CONFIRMED
//                       payment done (or free), seats are booked
//   booking-cancelled   type BOOKING_CANCELLED
//                       a person cancelled the booking
//   booking-expired     type BOOKING_EXPIRED
//                       payment was not completed in time, so the held seats were released

export function describeBookingJob(name, { quantity, eventTitle }) {
  switch (name) {
    case "booking-confirmed":
      return {
        type: "BOOKING_CONFIRMED",
        subject: `Booking confirmed: ${eventTitle}`,
        message: `Booking confirmed: ${quantity} seat(s) for ${eventTitle}`,
      };
    case "booking-cancelled":
      return {
        type: "BOOKING_CANCELLED",
        subject: `Booking cancelled: ${eventTitle}`,
        message: `Booking cancelled: ${quantity} seat(s) for ${eventTitle}`,
      };
    case "booking-expired":
      return {
        type: "BOOKING_EXPIRED",
        subject: `Booking expired: ${eventTitle}`,
        message: `Payment was not completed in time, so ${quantity} seat(s) for ${eventTitle} were released`,
      };
    default:
      throw new Error(`Unknown booking job: ${name}`);
  }
}
