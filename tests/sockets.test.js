import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as connect } from 'socket.io-client';
import { app, prisma, request, resetDb, makeUser, makeEvent, bearer } from './helpers.js';
import { initSockets, closeSockets } from '../src/sockets/index.js';

describe('live seats (socket.io)', () => {
  let server;
  let client;
  let admin;
  let alice;

  before(async () => {
    await resetDb();
    admin = await makeUser({ role: 'ADMIN' });
    alice = await makeUser();

    // Sockets need a real listening server (supertest alone is not enough); port 0 = any free port.
    server = http.createServer(app);
    initSockets(server);
    await new Promise((resolve) => server.listen(0, resolve));

    client = connect(`http://localhost:${server.address().port}`, { transports: ['websocket'] });
    await new Promise((resolve) => client.on('connect', resolve));
  });

  after(async () => {
    client.close();
    await closeSockets();
    await new Promise((resolve) => server.close(resolve));
    await resetDb();
    await prisma.$disconnect();
  });

  const join = (eventId) => new Promise((resolve) => client.emit('event:join', eventId, resolve));
  const nextUpdate = () => new Promise((resolve) => client.once('seats:update', resolve));

  it('rejects a malformed or unknown event id', async () => {
    assert.deepEqual(await join('nope'), { ok: false, error: 'Invalid event id' });
    assert.deepEqual(await join('00000000-0000-4000-8000-000000000000'), {
      ok: false,
      error: 'Event not found',
    });
  });

  it('sends the current seats on join, then pushes updates on booking and cancel', async () => {
    const event = await makeEvent(admin, { totalSeats: 10 });

    assert.deepEqual(await join(event.id), { ok: true, seatsLeft: 10 });

    // book 4 seats through the normal HTTP API...
    let update = nextUpdate();
    const booked = await request(app)
      .post('/api/bookings')
      .set(bearer(alice))
      .send({ eventId: event.id, quantity: 4 })
      .expect(201);
    // ...and the watcher is told without asking
    assert.deepEqual(await update, { eventId: event.id, seatsLeft: 6 });

    update = nextUpdate();
    await request(app)
      .patch(`/api/bookings/${booked.body.data.booking.id}/cancel`)
      .set(bearer(alice))
      .expect(200);
    assert.deepEqual(await update, { eventId: event.id, seatsLeft: 10 });
  });

  it('does not send updates for events you are not watching', async () => {
    const watched = await makeEvent(admin);
    const other = await makeEvent(admin);
    await join(watched.id);

    let received = false;
    const listener = () => (received = true);
    client.on('seats:update', listener);

    await request(app)
      .post('/api/bookings')
      .set(bearer(alice))
      .send({ eventId: other.id, quantity: 1 })
      .expect(201);
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(received, false);
    client.off('seats:update', listener);
  });
});
