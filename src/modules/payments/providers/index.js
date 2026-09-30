import { PAYMENT_PROVIDER, PAYMENT_WEBHOOK_SECRET } from '../../../config/env.js';
import { createFakeProvider } from './fake.provider.js';

// The rest of the app only ever imports `paymentProvider` from here. To add Razorpay or
// Stripe: write an adapter with the same interface as fake.provider.js, add it to the
// PAYMENT_PROVIDER enum in config/env.js, and return it from this switch.
function createProvider() {
  switch (PAYMENT_PROVIDER) {
    case 'fake':
      return createFakeProvider({ webhookSecret: PAYMENT_WEBHOOK_SECRET });
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER: ${PAYMENT_PROVIDER}`);
  }
}

export const paymentProvider = createProvider();
