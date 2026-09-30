import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app, prisma, request, resetDb, makeUser, makeEvent, bearer } from './helpers.js';

describe('events', () => {
  let admin;
  let user;

  before(async () => {
    await resetDb();
    admin = await makeUser({ role: 'ADMIN' });
    user = await makeUser();
  });
  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  const body = {
    title: 'Rock Night',
    city: 'Raipur',
    date: '2035-01-01T18:00:00Z',
    price: 100,
    totalSeats: 50,
  };

  it('only an admin can create an event', async () => {
    assert.equal((await request(app).post('/api/events').send(body)).status, 401);
    assert.equal((await request(app).post('/api/events').set(bearer(user)).send(body)).status, 403);

    const res = await request(app).post('/api/events').set(bearer(admin)).send(body);
    assert.equal(res.status, 201);
    assert.equal(res.body.data.event.seatsLeft, 50); // starts equal to totalSeats
  });

  it('rejects an invalid event (past date, no seats)', async () => {
    const res = await request(app)
      .post('/api/events')
      .set(bearer(admin))
      .send({ ...body, date: '2020-01-01', totalSeats: 0 });
    assert.equal(res.status, 400);
  });

  it('lists with filter, search, sort and pagination metadata', async () => {
    await makeEvent(admin, { title: 'Jazz Music Fest', city: 'Delhi', price: 300 });
    await makeEvent(admin, { title: 'Comedy Show', city: 'Raipur', price: 50 });

    const all = await request(app).get('/api/events');
    assert.equal(all.body.meta.total, 3);

    const raipur = await request(app).get('/api/events?city=Raipur');
    assert.equal(raipur.body.meta.total, 2);

    const search = await request(app).get('/api/events?q=jazz');
    assert.deepEqual(
      search.body.data.events.map((e) => e.title),
      ['Jazz Music Fest'],
    );

    const byPrice = await request(app).get('/api/events?sort=-price');
    assert.deepEqual(
      byPrice.body.data.events.map((e) => e.price),
      ['300', '100', '50'],
    );

    const page2 = await request(app).get('/api/events?page=2&limit=2');
    assert.equal(page2.body.data.events.length, 1);
    assert.equal(page2.body.meta.totalPages, 2);
  });

  it('rejects a bad query (page=0, unknown sort)', async () => {
    const res = await request(app).get('/api/events?page=0&sort=hack');
    assert.equal(res.status, 400);
  });

  it('returns 404 for an unknown event and 400 for a malformed id', async () => {
    const missing = await request(app).get('/api/events/00000000-0000-4000-8000-000000000000');
    assert.equal(missing.status, 404);
    assert.equal((await request(app).get('/api/events/abc')).status, 400);
  });

  it('unknown routes return a JSON 404', async () => {
    const res = await request(app).get('/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.status, 'error');
  });

  it('puts a request id on every response and reuses a safe one from the client', async () => {
    const generated = await request(app).get('/health');
    assert.match(generated.headers['x-request-id'], /^[0-9a-f-]{36}$/);

    const reused = await request(app).get('/health').set('X-Request-Id', 'my-trace-id-12345');
    assert.equal(reused.headers['x-request-id'], 'my-trace-id-12345');

    const unsafe = await request(app).get('/health').set('X-Request-Id', 'bad id with spaces');
    assert.notEqual(unsafe.headers['x-request-id'], 'bad id with spaces');
  });
});
