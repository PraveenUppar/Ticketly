import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import morgan from 'morgan';
import requestId from './middleware/requestId.js';
import { NODE_ENV } from './config/env.js';
import authRoutes from './modules/auth/auth.routes.js';
import eventRoutes from './modules/events/events.routes.js';
import bookingRoutes from './modules/bookings/bookings.routes.js';
import reviewRoutes from './modules/reviews/reviews.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import webhookRoutes from './modules/webhooks/webhooks.routes.js';
import { paymentRoutes, fakeProviderRoutes } from './modules/payments/payments.routes.js';
import { paymentProvider } from './modules/payments/providers/index.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

const app = express();

app.use(requestId); // first, so every later log line carries the request ID

// The payment provider signs the EXACT bytes it sends. express.json() would parse them and
// we could never reproduce the same bytes, so this one path gets the raw body instead.
// It MUST be registered before express.json(): a body can only be read once.
app.use('/api/payments/webhook', express.raw({ type: () => true, limit: '1mb' }));
app.use(express.json());

// One access-log line per request, in the same shape as our logger: time, level, [request id].
if (NODE_ENV !== 'test') {
  app.use(
    morgan((tokens, req, res) =>
      [
        new Date().toISOString(),
        'HTTP '.padEnd(5),
        `[${req.id}]`,
        tokens.method(req, res),
        tokens.url(req, res),
        tokens.status(req, res),
        `${tokens['response-time'](req, res)}ms`,
      ].join(' '),
    ),
  );
}

// Serves public/live-seats.html, a tiny page to watch Socket.io updates in the browser.
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api', reviewRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/payments', paymentRoutes);

// Lets you play the payment provider while developing. Only exists with the fake provider,
// which config/env.js already refuses to start in production.
if (paymentProvider.name === 'fake') {
  app.use('/api/dev/fake-provider', fakeProviderRoutes);
}

app.use(notFound);
app.use(errorHandler);

export default app;
