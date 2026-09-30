// Events an endpoint can subscribe to.
export const WEBHOOK_EVENTS = [
  'booking.confirmed', // paid (or free) booking is final
  'booking.cancelled',
  'booking.expired', // unpaid seats were released
  'event.finished',
];

// 1 first try + 5 retries. With exponential backoff from a 30s base the waits are
// 30s, 1m, 2m, 4m, 8m (about 15 minutes in total). Real providers stretch this over hours.
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_BACKOFF_MS = 30_000;

// How long we wait for the receiver to answer before counting the attempt as failed.
export const WEBHOOK_TIMEOUT_MS = 5000;

// After this many deliveries in a row fail even after all retries, the endpoint is switched off.
export const WEBHOOK_MAX_CONSECUTIVE_FAILURES = 5;
