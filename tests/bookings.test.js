import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app, prisma, request, resetDb, makeUser, makeEvent, bearer } from './helpers.js';

describe('bookings', () => {
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

  const book = (user, eventId, quantity) =>
    request(app).post('/api/bookings').set(bearer(user)).send({ eventId, quantity });

  const seatsLeft = async (eventId) =>
    (await prisma.event.findUnique({ where: { id: eventId } })).seatsLeft;

  it('requires login', async () => {
    const event = await makeEvent(admin);
    const res = await request(app).post('/api/bookings').send({ eventId: event.id, quantity: 1 });
    assert.equal(res.status, 401);
  });

  it('books seats and reduces seatsLeft', async () => {
    const event = await makeEvent(admin, { totalSeats: 10 });

    const res = await book(alice, event.id, 3);

    assert.equal(res.status, 201);
    // the test event costs money, so the seats are HELD until the payment webhook confirms them
    // (payments.test.js covers that part)
    assert.equal(res.body.data.booking.status, 'PENDING_PAYMENT');
    assert.equal(res.body.data.seatsLeft, 7);
    assert.equal(await seatsLeft(event.id), 7);
  });

  it('rejects invalid input and unknown events', async () => {
    const event = await makeEvent(admin);
    assert.equal((await book(alice, event.id, 0)).status, 400);
    assert.equal((await book(alice, 'not-a-uuid', 1)).status, 400);
    assert.equal((await book(alice, '00000000-0000-4000-8000-000000000000', 1)).status, 404);
  });

  it('refuses to book more seats than are left and changes nothing', async () => {
    const event = await makeEvent(admin, { totalSeats: 2 });

    const res = await book(alice, event.id, 3);

    assert.equal(res.status, 409);
    assert.equal(await seatsLeft(event.id), 2);
    assert.equal(await prisma.booking.count({ where: { eventId: event.id } }), 0);
  });

  it('never sells the same last seats twice (concurrent requests)', async () => {
    const event = await makeEvent(admin, { totalSeats: 3 });

    // 12 requests fire at once for 3 seats
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => book(i % 2 ? alice : bob, event.id, 1)),
    );

    const booked = results.filter((r) => r.status === 201).length;
    const soldOut = results.filter((r) => r.status === 409).length;
    assert.equal(booked, 3);
    assert.equal(soldOut, 9);
    assert.equal(await seatsLeft(event.id), 0);
    assert.equal(
      await prisma.booking.count({
        where: { eventId: event.id, status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] } },
      }),
      3,
    );
  });

  describe('cancel', () => {
    it('gives the seats back', async () => {
      const event = await makeEvent(admin, { totalSeats: 5 });
      const { body } = await book(alice, event.id, 2);
      assert.equal(await seatsLeft(event.id), 3);

      const res = await request(app)
        .patch(`/api/bookings/${body.data.booking.id}/cancel`)
        .set(bearer(alice));

      assert.equal(res.status, 200);
      assert.equal(res.body.data.booking.status, 'CANCELLED');
      assert.equal(await seatsLeft(event.id), 5);
    });

    it('does not let someone cancel a booking that belongs to another user', async () => {
      const event = await makeEvent(admin);
      const { body } = await book(alice, event.id, 1);

      const res = await request(app)
        .patch(`/api/bookings/${body.data.booking.id}/cancel`)
        .set(bearer(bob));

      assert.equal(res.status, 403);
      assert.equal(await seatsLeft(event.id), 9);
    });

    it('lets an admin cancel any booking', async () => {
      const event = await makeEvent(admin);
      const { body } = await book(alice, event.id, 1);

      const res = await request(app)
        .patch(`/api/bookings/${body.data.booking.id}/cancel`)
        .set(bearer(admin));

      assert.equal(res.status, 200);
    });

    it('returns the seats only once, even when cancelled several times at once', async () => {
      const event = await makeEvent(admin, { totalSeats: 5 });
      const { body } = await book(alice, event.id, 2);
      const url = `/api/bookings/${body.data.booking.id}/cancel`;

      const results = await Promise.all(
        Array.from({ length: 5 }, () => request(app).patch(url).set(bearer(alice))),
      );

      assert.equal(results.filter((r) => r.status === 200).length, 1);
      assert.equal(results.filter((r) => r.status === 409).length, 4);
      assert.equal(await seatsLeft(event.id), 5); // not 5 plus extras
    });
  });

  it('lists only my own bookings, and only I (or an admin) can open one', async () => {
    const event = await makeEvent(admin);
    const { body } = await book(alice, event.id, 1);
    const id = body.data.booking.id;

    const mine = await request(app).get('/api/bookings/me').set(bearer(alice));
    assert.ok(mine.body.data.bookings.every((b) => b.userId === alice.id));

    assert.equal((await request(app).get(`/api/bookings/${id}`).set(bearer(alice))).status, 200);
    assert.equal((await request(app).get(`/api/bookings/${id}`).set(bearer(bob))).status, 403);
  });

  it('cannot delete an event that has bookings', async () => {
    const event = await makeEvent(admin);
    await book(alice, event.id, 1);

    const res = await request(app).delete(`/api/events/${event.id}`).set(bearer(admin));
    assert.equal(res.status, 409);
  });
});
