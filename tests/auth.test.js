import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { app, prisma, request, resetDb, makeUser, bearer } from './helpers.js';

describe('auth', () => {
  before(resetDb);
  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  describe('POST /api/auth/signup', () => {
    it('creates a user and never returns the password hash', async () => {
      const res = await request(app)
        .post('/api/auth/signup')
        .send({ email: 'Alice@Test.local', password: 'password123' });

      assert.equal(res.status, 201);
      assert.equal(res.body.data.user.email, 'alice@test.local'); // lowercased by Zod
      assert.equal(res.body.data.user.role, 'USER');
      assert.equal(res.body.data.user.passwordHash, undefined);
      assert.equal(res.body.data.user.password, undefined);
    });

    it('ignores a role sent in the body (no self-promotion to ADMIN)', async () => {
      const res = await request(app)
        .post('/api/auth/signup')
        .send({ email: 'sneaky@test.local', password: 'password123', role: 'ADMIN' });

      assert.equal(res.status, 201);
      assert.equal(res.body.data.user.role, 'USER');
    });

    it('returns 409 for a duplicate email', async () => {
      const res = await request(app)
        .post('/api/auth/signup')
        .send({ email: 'alice@test.local', password: 'password123' });

      assert.equal(res.status, 409);
      assert.equal(res.body.status, 'error');
    });

    it('returns 400 with field details for invalid input', async () => {
      const res = await request(app).post('/api/auth/signup').send({ email: 'nope', password: '123' });

      assert.equal(res.status, 400);
      const fields = res.body.details.map((d) => d.field);
      assert.ok(fields.includes('body.email'));
      assert.ok(fields.includes('body.password'));
    });
  });

  describe('POST /api/auth/login', () => {
    it('returns a token for correct credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'alice@test.local', password: 'password123' });

      assert.equal(res.status, 200);
      const payload = jwt.decode(res.body.data.token);
      assert.equal(payload.sub, res.body.data.user.id); // id is stored in the standard sub claim
      assert.equal(payload.role, 'USER');
    });

    it('gives the SAME 401 message for a wrong password and an unknown email', async () => {
      const wrongPassword = await request(app)
        .post('/api/auth/login')
        .send({ email: 'alice@test.local', password: 'wrong-password' });
      const unknownEmail = await request(app)
        .post('/api/auth/login')
        .send({ email: 'ghost@test.local', password: 'password123' });

      assert.equal(wrongPassword.status, 401);
      assert.equal(unknownEmail.status, 401);
      assert.equal(wrongPassword.body.message, unknownEmail.body.message);
    });
  });

  describe('GET /api/auth/me (requireAuth)', () => {
    it('returns the current user with a valid token', async () => {
      const user = await makeUser();
      const res = await request(app).get('/api/auth/me').set(bearer(user));

      assert.equal(res.status, 200);
      assert.equal(res.body.data.user.email, user.email);
    });

    it('rejects a missing token', async () => {
      const res = await request(app).get('/api/auth/me');
      assert.equal(res.status, 401);
    });

    it('rejects a tampered token', async () => {
      const user = await makeUser();
      const res = await request(app)
        .get('/api/auth/me')
        .set({ Authorization: `Bearer ${user.token}x` });
      assert.equal(res.status, 401);
    });

    it('rejects an expired token', async () => {
      const user = await makeUser();
      const expired = jwt.sign({ sub: user.id, role: 'USER' }, process.env.JWT_SECRET, {
        expiresIn: -10,
      });
      const res = await request(app).get('/api/auth/me').set({ Authorization: `Bearer ${expired}` });
      assert.equal(res.status, 401);
    });
  });
});
