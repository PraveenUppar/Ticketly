import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app, prisma, request, resetDb, makeUser, makeEvent, bearer } from './helpers.js';
import { PAYMENT_WEBHOOK_SECRET } from '../src/config/env.js';
import { signPayload } from '../src/modules/webhooks/webhooks.security.js';
import { paymentProvider } from '../src/modules/payments/providers/index.js';
import { requestRefund, processPendingRefunds } from '../src/modules/payments/payments.service.js';
import { releaseExpiredBookings } from '../src/modules/bookings/bookings.service.js';

// ---------------------------------------------------------------------------
// Playing the payment provider: build an event and send it, correctly signed, to the real route.
// ---------------------------------------------------------------------------
const providerEvent = (type, order, data = {}) => ({
  id: `evt_${crypto.randomUUID()}`,
  type,
  data: {
    orderId: order.orderId,
    paymentId: 'pay_test_1',
    amountMinor: order.amountMinor,
    currency: order.currency,
    ...data,
  },
});

const deliver = (event, signOptions) => {
  const { rawBody, headers } = paymentProvider.signEvent(event, signOptions);
  return request(app)
    .post('/api/payments/webhook')
    .set('content-type', 'application/json')
    .set(headers)
    .send(rawBody);
};

describe('payments', () => {
  let admin;
  let alice;
  let bob;

  before(async () => {
    await resetDb();
    admin = await makeUser({ role: 'ADMIN' });
    alice = await makeUser();
    bob = await makeUser();
  });
  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  // price 250.00 = 25000 paise per seat
  const paidEvent = (overrides) => makeEvent(admin, { price: 250, totalSeats: 10, ...overrides });

  const book = async (user, event, quantity = 2) => {
    const res = await request(app)
      .post('/api/bookings')
      .set(bearer(user))
      .send({ eventId: event.id, quantity });
    return res;
  };
  // book and return { booking, order }
  const bookPaid = async (user, event, quantity = 2) => {
    const res = await book(user, event, quantity);
    assert.equal(res.status, 201);
    return { booking: res.body.data.booking, order: res.body.data.payment };
  };

  const bookingRow = (id) => prisma.booking.findUnique({ where: { id } });
  const paymentRow = (bookingId) => prisma.payment.findUnique({ where: { bookingId } });
  const seatsLeft = async (eventId) => (await prisma.event.findUnique({ where: { id: eventId } })).seatsLeft;
  const cancel = (user, bookingId) =>
    request(app).patch(`/api/bookings/${bookingId}/cancel`).set(bearer(user));

  // -------------------------------------------------------------------------
  describe('reserving seats', () => {
    it('holds the seats as PENDING_PAYMENT with a price snapshot and a payment order', async () => {
      const event = await paidEvent();
      const res = await book(alice, event, 2);

      assert.equal(res.status, 201);
      const { booking, payment, seatsLeft: left } = res.body.data;
      assert.equal(booking.status, 'PENDING_PAYMENT');
      assert.equal(booking.amountMinor, 50000); // 2 seats x 25000
      assert.equal(booking.currency, 'INR');
      assert.equal(left, 8);

      assert.match(payment.orderId, /^order_fake_/);
      assert.equal(payment.status, 'CREATED');
      assert.equal(payment.amountMinor, 50000);
      assert.equal(payment.checkout.orderId, payment.orderId);

      const minutes = (new Date(payment.expiresAt) - Date.now()) / 60_000;
      assert.ok(minutes > 14 && minutes <= 15, `hold should be about 15 minutes, got ${minutes}`);

      const shown = await request(app).get(`/api/bookings/${booking.id}`).set(bearer(alice));
      assert.equal(shown.body.data.booking.payment.status, 'CREATED');
    });

    it('keeps the amount even if the admin changes the price afterwards', async () => {
      const event = await paidEvent();
      const { booking } = await bookPaid(alice, event, 1);

      await request(app).patch(`/api/events/${event.id}`).set(bearer(admin)).send({ price: 999 }).expect(200);

      assert.equal((await bookingRow(booking.id)).amountMinor, 25000);
    });

    it('confirms a FREE event immediately, with no payment', async () => {
      const event = await paidEvent({ price: 0 });
      const res = await book(alice, event, 3);

      assert.equal(res.status, 201);
      assert.equal(res.body.data.booking.status, 'CONFIRMED');
      assert.equal(res.body.data.booking.expiresAt, null);
      assert.equal(res.body.data.payment, null);
      assert.equal(await paymentRow(res.body.data.booking.id), null);
    });

    it('gives the seats back if the payment provider is down (compensation)', async () => {
      const event = await paidEvent({ totalSeats: 5 });
      const original = paymentProvider.createOrder;
      paymentProvider.createOrder = async () => {
        throw new Error('provider exploded');
      };

      try {
        const res = await book(alice, event, 2);
        assert.equal(res.status, 502);
      } finally {
        paymentProvider.createOrder = original;
      }

      assert.equal(await seatsLeft(event.id), 5); // not held for nothing
      const rows = await prisma.booking.findMany({ where: { eventId: event.id } });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'CANCELLED');
    });
  });

  // -------------------------------------------------------------------------
  describe('the payment webhook: confirming', () => {
    it('confirms the booking when payment.succeeded arrives', async () => {
      const event = await paidEvent();
      const { booking, order } = await bookPaid(alice, event);

      const res = await deliver(providerEvent('payment.succeeded', order));

      assert.equal(res.status, 200);
      assert.equal(res.body.result, 'confirmed');
      const row = await bookingRow(booking.id);
      assert.equal(row.status, 'CONFIRMED');
      assert.equal(row.expiresAt, null);
      const payment = await paymentRow(booking.id);
      assert.equal(payment.status, 'SUCCEEDED');
      assert.equal(payment.providerPaymentId, 'pay_test_1');
      assert.equal(await seatsLeft(event.id), 8); // confirming does not change the seat count
    });

    it('ignores a duplicate delivery of the same event id', async () => {
      const event = await paidEvent();
      const { booking, order } = await bookPaid(alice, event);
      const evt = providerEvent('payment.succeeded', order);

      assert.equal((await deliver(evt)).body.result, 'confirmed');
      const again = await deliver(evt);

      assert.equal(again.status, 200);
      assert.equal(again.body.result, 'duplicate');
      const stored = await prisma.paymentWebhookEvent.count({ where: { providerEventId: evt.id } });
      assert.equal(stored, 1);
      assert.equal((await bookingRow(booking.id)).status, 'CONFIRMED');
    });

    it('a second event for an already-paid order changes nothing', async () => {
      const event = await paidEvent();
      const { order } = await bookPaid(alice, event);

      await deliver(providerEvent('payment.succeeded', order));
      const res = await deliver(providerEvent('payment.succeeded', order)); // NEW event id, same order

      assert.equal(res.status, 200);
      assert.equal(res.body.result, 'already-processed');
    });

    it('does not confirm when the paid amount differs from what we charged', async () => {
      const event = await paidEvent();
      const { booking, order } = await bookPaid(alice, event);

      const res = await deliver(providerEvent('payment.succeeded', order, { amountMinor: 1 }));

      assert.equal(res.status, 200); // acknowledged, so the provider stops retrying...
      assert.equal(res.body.result, 'amount-mismatch');
      assert.equal((await bookingRow(booking.id)).status, 'PENDING_PAYMENT'); // ...but nothing was confirmed
      assert.equal((await paymentRow(booking.id)).status, 'CREATED');
    });

    it('acknowledges unknown orders and unknown event types without changing anything', async () => {
      const unknownOrder = await deliver(providerEvent('payment.succeeded', { orderId: 'order_nope', amountMinor: 1, currency: 'INR' }));
      assert.equal(unknownOrder.status, 200);
      assert.equal(unknownOrder.body.result, 'unknown-order');

      const event = await paidEvent();
      const { order } = await bookPaid(alice, event);
      const other = await deliver(providerEvent('customer.created', order));
      assert.equal(other.body.result, 'ignored');
    });

    it('keeps holding the seats after payment.failed, and a retry on the same order can still succeed', async () => {
      const event = await paidEvent();
      const { booking, order } = await bookPaid(alice, event);

      const failed = await deliver(providerEvent('payment.failed', order));
      assert.equal(failed.body.result, 'payment-failed');
      assert.equal((await paymentRow(booking.id)).status, 'FAILED');
      assert.equal((await bookingRow(booking.id)).status, 'PENDING_PAYMENT');

      const retry = await deliver(providerEvent('payment.succeeded', order));
      assert.equal(retry.body.result, 'confirmed');
      assert.equal((await paymentRow(booking.id)).status, 'SUCCEEDED');
    });
  });

  // -------------------------------------------------------------------------
  describe('the payment webhook: authenticity', () => {
    let order;
    let booking;
    before(async () => {
      ({ booking, order } = await bookPaid(alice, await paidEvent()));
    });
    const stillPending = async () => assert.equal((await bookingRow(booking.id)).status, 'PENDING_PAYMENT');

    it('rejects a wrong signature', async () => {
      const { rawBody, headers } = paymentProvider.signEvent(providerEvent('payment.succeeded', order));
      const res = await request(app)
        .post('/api/payments/webhook')
        .set('content-type', 'application/json')
        .set({ ...headers, 'x-fake-signature': 'sha256=' + 'a'.repeat(64) })
        .send(rawBody);
      assert.equal(res.status, 401);
      await stillPending();
    });

    it('rejects a body that was changed after signing', async () => {
      const { rawBody, headers } = paymentProvider.signEvent(providerEvent('payment.succeeded', order));
      const res = await request(app)
        .post('/api/payments/webhook')
        .set('content-type', 'application/json')
        .set(headers)
        .send(rawBody.replace('pay_test_1', 'pay_test_2'));
      assert.equal(res.status, 401);
      await stillPending();
    });

    it('rejects a replayed request with an old timestamp', async () => {
      const old = String(Math.floor(Date.now() / 1000) - 3600);
      const res = await deliver(providerEvent('payment.succeeded', order), { timestamp: old });
      assert.equal(res.status, 401);
      await stillPending();
    });

    it('rejects a request with no signature headers at all', async () => {
      const res = await request(app)
        .post('/api/payments/webhook')
        .set('content-type', 'application/json')
        .send(JSON.stringify(providerEvent('payment.succeeded', order)));
      assert.equal(res.status, 401);
      await stillPending();
    });

    it('rejects an empty body, and a correctly signed body that is not valid JSON or has the wrong shape', async () => {
      assert.equal((await request(app).post('/api/payments/webhook')).status, 400);

      // signed correctly, but the CONTENT is bad: this proves a valid signature is not enough
      for (const body of ['{not json', '{"hello":"world"}']) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const res = await request(app)
          .post('/api/payments/webhook')
          .set('x-fake-timestamp', timestamp)
          .set('x-fake-signature', signPayload(PAYMENT_WEBHOOK_SECRET, timestamp, body))
          .send(body);
        assert.equal(res.status, 400, body);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('expiry', () => {
    it('releases seats of unpaid bookings whose hold ran out', async () => {
      const event = await paidEvent({ totalSeats: 10 });
      const stale = await bookPaid(alice, event, 3);
      const fresh = await bookPaid(bob, event, 2);
      assert.equal(await seatsLeft(event.id), 5);

      await prisma.booking.update({ where: { id: stale.booking.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

      assert.equal(await releaseExpiredBookings(), 1);
      assert.equal((await bookingRow(stale.booking.id)).status, 'EXPIRED');
      assert.equal((await bookingRow(fresh.booking.id)).status, 'PENDING_PAYMENT'); // untouched
      assert.equal(await seatsLeft(event.id), 8); // only the expired 3 came back
      assert.equal(await releaseExpiredBookings(), 0); // running it again changes nothing
      assert.equal(await seatsLeft(event.id), 8);
    });

    it('never expires a booking that has been paid', async () => {
      const event = await paidEvent();
      const { booking, order } = await bookPaid(alice, event);
      await prisma.booking.update({ where: { id: booking.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await deliver(providerEvent('payment.succeeded', order)); // confirming clears expiresAt

      await releaseExpiredBookings();
      assert.equal((await bookingRow(booking.id)).status, 'CONFIRMED');
    });

    it('refunds a payment that arrives AFTER the hold expired, and does not resurrect the booking', async () => {
      const event = await paidEvent({ totalSeats: 10 });
      const { booking, order } = await bookPaid(alice, event, 2);
      await prisma.booking.update({ where: { id: booking.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await releaseExpiredBookings();
      assert.equal(await seatsLeft(event.id), 10);

      const late = await deliver(providerEvent('payment.succeeded', order));

      assert.equal(late.body.result, 'late-payment');
      assert.equal((await bookingRow(booking.id)).status, 'EXPIRED'); // seats may already belong to someone else
      assert.equal(await seatsLeft(event.id), 10); // and were NOT taken again
      const payment = await paymentRow(booking.id);
      assert.equal(payment.status, 'REFUND_PENDING');
      assert.match(payment.providerRefundId, /^rf_fake_/);

      const done = await deliver(providerEvent('refund.processed', order));
      assert.equal(done.body.result, 'refunded');
      assert.equal((await paymentRow(booking.id)).status, 'REFUNDED');
    });
  });

  // -------------------------------------------------------------------------
  describe('cancelling and refunds', () => {
    it('cancelling a PAID booking returns the seats and starts a refund', async () => {
      const event = await paidEvent({ totalSeats: 10 });
      const { booking, order } = await bookPaid(alice, event, 2);
      await deliver(providerEvent('payment.succeeded', order));

      const res = await cancel(alice, booking.id);

      assert.equal(res.status, 200);
      assert.equal(await seatsLeft(event.id), 10);
      const payment = await paymentRow(booking.id);
      assert.equal(payment.status, 'REFUND_PENDING');
      assert.ok(payment.providerRefundId);

      assert.equal((await deliver(providerEvent('refund.processed', order))).body.result, 'refunded');
      assert.equal((await paymentRow(booking.id)).status, 'REFUNDED');
    });

    it('cancelling an UNPAID booking frees the seats, starts no refund, and refunds a payment that shows up later', async () => {
      const event = await paidEvent({ totalSeats: 10 });
      const { booking, order } = await bookPaid(alice, event, 4);

      assert.equal((await cancel(alice, booking.id)).status, 200);
      assert.equal(await seatsLeft(event.id), 10);
      assert.equal((await paymentRow(booking.id)).status, 'CREATED'); // nothing was paid, nothing to refund

      const late = await deliver(providerEvent('payment.succeeded', order));
      assert.equal(late.body.result, 'late-payment');
      assert.equal((await paymentRow(booking.id)).status, 'REFUND_PENDING');
      assert.equal(await seatsLeft(event.id), 10);
    });

    it('does not let someone else cancel it, or cancel it twice', async () => {
      const event = await paidEvent();
      const { booking } = await bookPaid(alice, event);

      assert.equal((await cancel(bob, booking.id)).status, 403);
      assert.equal((await cancel(alice, booking.id)).status, 200);
      assert.equal((await cancel(alice, booking.id)).status, 409);
    });

    it('a refund that failed is retried by the sweep, without ever refunding twice', async () => {
      const event = await paidEvent();
      const { booking, order } = await bookPaid(alice, event);
      await deliver(providerEvent('payment.succeeded', order));
      // cancelled in the database, but the refund call never happened (crash, provider outage...)
      await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } });
      const payment = await paymentRow(booking.id);

      const brokenProvider = { refund: async () => { throw new Error('provider down'); } };
      await assert.rejects(requestRefund(payment.id, { provider: brokenProvider }), /provider down/);
      assert.equal((await paymentRow(booking.id)).status, 'SUCCEEDED'); // put back, so it can be retried

      assert.ok((await processPendingRefunds()) >= 1);
      const after = await paymentRow(booking.id);
      assert.equal(after.status, 'REFUND_PENDING');

      // the provider honours the idempotency key: the same request gives the same refund
      const key = `refund-${payment.id}`;
      const a = await paymentProvider.refund({ idempotencyKey: key });
      const b = await paymentProvider.refund({ idempotencyKey: key });
      assert.equal(a.providerRefundId, b.providerRefundId);
      assert.equal(after.providerRefundId, a.providerRefundId);
    });

    it('never refunds a payment whose booking is still live', async () => {
      const event = await paidEvent();
      const { booking, order } = await bookPaid(alice, event);
      await deliver(providerEvent('payment.succeeded', order));
      const payment = await paymentRow(booking.id);

      assert.equal(await requestRefund(payment.id), 'skipped');
      assert.equal((await paymentRow(booking.id)).status, 'SUCCEEDED');
    });
  });

  // -------------------------------------------------------------------------
  describe('races', () => {
    it('payment and cancel arriving together always end in a consistent state', async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const whoWon = { paymentFirst: 0, cancelFirst: 0 };

      for (let round = 0; round < 8; round++) {
        const event = await paidEvent({ totalSeats: 10 });
        const { booking, order } = await bookPaid(alice, event, 2);

        // The user cancels at (nearly) the very moment the payment succeeds. The cancel is delayed
        // by a different amount each round, so both orders of arrival get exercised.
        const [hook] = await Promise.all([
          deliver(providerEvent('payment.succeeded', order)),
          sleep(round * 6).then(() => cancel(alice, booking.id)),
        ]);
        whoWon[hook.body.result === 'confirmed' ? 'paymentFirst' : 'cancelFirst']++;
        await processPendingRefunds(); // the safety net, in case a refund attempt lost a race

        const row = await bookingRow(booking.id);
        const payment = await paymentRow(booking.id);
        if (row.status === 'CONFIRMED') {
          assert.equal(payment.status, 'SUCCEEDED', `round ${round}: paid and kept`);
          assert.equal(await seatsLeft(event.id), 8);
        } else {
          assert.equal(row.status, 'CANCELLED', `round ${round}`);
          assert.ok(['REFUND_PENDING', 'REFUNDED'].includes(payment.status), `round ${round}: money must go back, was ${payment.status}`);
          assert.equal(await seatsLeft(event.id), 10, `round ${round}: seats freed exactly once`);
        }
      }
      // Both interleavings should have happened; whichever won, the outcome above was consistent.
      console.log(`      race outcomes: ${JSON.stringify(whoWon)}`);
    });
  });

  // -------------------------------------------------------------------------
  describe('dev helper: play the payment provider (fake provider only)', () => {
    const simulate = (user, body) =>
      request(app).post('/api/dev/fake-provider/events').set(user ? bearer(user) : {}).send(body);

    it('lets the booking owner "pay" for an order, through the same code as the real webhook', async () => {
      const { booking, order } = await bookPaid(alice, await paidEvent());

      const res = await simulate(alice, { type: 'payment.succeeded', orderId: order.orderId });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.result, 'confirmed');
      assert.equal((await bookingRow(booking.id)).status, 'CONFIRMED');
    });

    it('is protected: login required, own orders only, valid input', async () => {
      const { order } = await bookPaid(alice, await paidEvent());

      assert.equal((await simulate(null, { type: 'payment.succeeded', orderId: order.orderId })).status, 401);
      assert.equal((await simulate(bob, { type: 'payment.succeeded', orderId: order.orderId })).status, 403);
      assert.equal((await simulate(alice, { type: 'payment.succeeded', orderId: 'order_nope' })).status, 404);
      assert.equal((await simulate(alice, { type: 'money.printed', orderId: order.orderId })).status, 400);
    });
  });
});
