import { Router } from 'express';
import validate from '../../middleware/validate.js';
import requireAuth from '../../middleware/auth.js';
import { simulateEventSchema } from './payments.schema.js';
import { receiveWebhook, simulateProviderEvent } from './payments.controller.js';

// Mounted at /api/payments
export const paymentRoutes = Router();
paymentRoutes.post('/webhook', receiveWebhook); // public, authenticated by signature

// Mounted at /api/dev/fake-provider, and only when the fake provider is in use (see app.js)
export const fakeProviderRoutes = Router();
fakeProviderRoutes.post('/events', requireAuth, validate(simulateEventSchema), simulateProviderEvent);
