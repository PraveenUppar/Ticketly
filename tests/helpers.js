import request from 'supertest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import { DATABASE_URL } from '../src/config/env.js';

// Safety net: tests delete EVERYTHING, so refuse to run against anything but the test database.
if (!DATABASE_URL.includes('_test')) {
  throw new Error('Refusing to run tests: DATABASE_URL must point to a *_test database.');
}

export { app, prisma, request };

export async function resetDb() {
  // children first: payments reference bookings, bookings reference users and events
  await prisma.paymentWebhookEvent.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.event.deleteMany();
  await prisma.user.deleteMany();
}

let counter = 0;

// Signs up through the real API, optionally promotes to ADMIN directly in the DB
// (there is no API for that on purpose), then logs in. Returns { id, email, token }.
export async function makeUser({ role = 'USER' } = {}) {
  const email = `user${Date.now()}${counter++}@test.local`;
  const password = 'password123';

  await request(app).post('/api/auth/signup').send({ email, password }).expect(201);
  if (role === 'ADMIN') {
    await prisma.user.update({ where: { email }, data: { role: 'ADMIN' } });
  }
  const res = await request(app).post('/api/auth/login').send({ email, password }).expect(200);

  return { id: res.body.data.user.id, email, password, token: res.body.data.token };
}

export const bearer = (user) => ({ Authorization: `Bearer ${user.token}` });

export async function makeEvent(admin, overrides = {}) {
  const res = await request(app)
    .post('/api/events')
    .set(bearer(admin))
    .send({
      title: 'Test Concert',
      city: 'Raipur',
      date: '2035-01-01T18:00:00Z',
      price: 250,
      totalSeats: 10,
      ...overrides,
    })
    .expect(201);
  return res.body.data.event;
}
