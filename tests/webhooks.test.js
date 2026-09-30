import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app, prisma, request, resetDb, makeUser, bearer } from './helpers.js';
import {
  generateSecret,
  signPayload,
  verifySignature,
  isPrivateAddress,
  assertSafeWebhookUrl,
  makeSafeLookup,
} from '../src/modules/webhooks/webhooks.security.js';
import {
  dispatchWebhook,
  deliverWebhook,
  postJson,
  buildEnvelope,
} from '../src/modules/webhooks/webhooks.service.js';
import { markFinishedEvents } from '../src/jobs/cron.js';

// ---------------------------------------------------------------------------
// A tiny receiver we control: records every request and answers with `respond`.
// ---------------------------------------------------------------------------
function startReceiver() {
  const received = [];
  const state = { respond: (req, res) => res.writeHead(200).end('ok') };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body, method: req.method });
      state.respond(req, res);
    });
  });

  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/hook`,
        received,
        state,
        close: () => new Promise((done) => (server.closeAllConnections(), server.close(done))),
      }),
    ),
  );
}

const noRecord = () => {
  const records = [];
  return { records, record: async (entry) => records.push(entry) };
};

describe('webhooks', () => {
  let admin;
  let user;

  before(async () => {
    await resetDb();
    await prisma.webhookEndpoint.deleteMany();
    admin = await makeUser({ role: 'ADMIN' });
    user = await makeUser();
  });
  after(async () => {
    await prisma.webhookEndpoint.deleteMany();
    await resetDb();
    await prisma.$disconnect();
  });
  beforeEach(() => prisma.webhookEndpoint.deleteMany());

  // -------------------------------------------------------------------------
  describe('signing', () => {
    const secret = generateSecret();
    const body = JSON.stringify({ hello: 'world' });
    const now = () => String(Math.floor(Date.now() / 1000));

    it('generates prefixed random secrets', () => {
      assert.match(secret, /^whsec_[0-9a-f]{48}$/);
      assert.notEqual(generateSecret(), generateSecret());
    });

    it('accepts a correct signature', () => {
      const timestamp = now();
      const signature = signPayload(secret, timestamp, body);
      assert.equal(verifySignature({ secret, timestamp, body, signature }), true);
    });

    it('rejects a tampered body, a wrong secret and a garbage signature', () => {
      const timestamp = now();
      const signature = signPayload(secret, timestamp, body);
      assert.equal(verifySignature({ secret, timestamp, body: body + ' ', signature }), false);
      assert.equal(verifySignature({ secret: 'other', timestamp, body, signature }), false);
      assert.equal(verifySignature({ secret, timestamp, body, signature: 'sha256=abc' }), false);
      assert.equal(verifySignature({ secret, timestamp, body, signature: undefined }), false);
    });

    it('rejects an old timestamp (replay protection), even with a valid signature for it', () => {
      const old = String(Math.floor(Date.now() / 1000) - 3600);
      const signature = signPayload(secret, old, body);
      assert.equal(verifySignature({ secret, timestamp: old, body, signature }), false);
    });

    it('the timestamp is part of what is signed', () => {
      const timestamp = now();
      const signature = signPayload(secret, timestamp, body);
      const shifted = String(Number(timestamp) + 1);
      assert.equal(verifySignature({ secret, timestamp: shifted, body, signature }), false);
    });
  });

  // -------------------------------------------------------------------------
  describe('SSRF protection', () => {
    it('recognises private, loopback and metadata addresses', () => {
      for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
        assert.equal(isPrivateAddress(ip), true, ip);
      }
      for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
        assert.equal(isPrivateAddress(ip), false, ip);
      }
    });

    it('rejects unsafe URLs when private targets are not allowed', async () => {
      const bad = [
        'not a url',
        'http://8.8.8.8/hook', // http not allowed
        'ftp://8.8.8.8/hook',
        'https://127.0.0.1/hook',
        'https://[::1]/hook',
        'https://10.0.0.5/hook',
        'https://169.254.169.254/latest/meta-data',
        'https://localhost/hook',
        'https://user:pass@8.8.8.8/hook',
      ];
      for (const url of bad) {
        await assert.rejects(assertSafeWebhookUrl(url, { allowPrivate: false }), { statusCode: 400 }, url);
      }
    });

    it('accepts a public https URL', async () => {
      await assert.doesNotReject(assertSafeWebhookUrl('https://8.8.8.8/hook', { allowPrivate: false }));
    });

    it('re-checks at connection time (defends against DNS rebinding)', async () => {
      const lookup = makeSafeLookup(false);
      const err = await new Promise((resolve) => lookup('localhost', {}, (e) => resolve(e)));
      assert.match(err.message, /Blocked/);
    });

    it('postJson refuses an IP-literal private target', async () => {
      await assert.rejects(
        postJson('http://127.0.0.1:1/hook', { headers: {}, body: '{}', allowPrivate: false }),
        /Blocked/,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('admin API', () => {
    const create = (who, body) => request(app).post('/api/webhooks').set(bearer(who)).send(body);
    const valid = { url: 'http://localhost:9999/hook', events: ['booking.confirmed'] };

    it('is admin only', async () => {
      assert.equal((await request(app).post('/api/webhooks').send(valid)).status, 401);
      assert.equal((await create(user, valid)).status, 403);
      assert.equal((await request(app).get('/api/webhooks').set(bearer(user))).status, 403);
    });

    it('returns the secret exactly once', async () => {
      const created = await create(admin, valid);
      assert.equal(created.status, 201);
      assert.match(created.body.data.webhook.secret, /^whsec_/);

      const list = await request(app).get('/api/webhooks').set(bearer(admin));
      assert.equal(list.body.data.webhooks.length, 1);
      assert.equal(list.body.data.webhooks[0].secret, undefined);
    });

    it('validates url and events', async () => {
      assert.equal((await create(admin, { url: 'nope', events: ['booking.confirmed'] })).status, 400);
      assert.equal((await create(admin, { url: valid.url, events: [] })).status, 400);
      assert.equal((await create(admin, { url: valid.url, events: ['user.exploded'] })).status, 400);
      assert.equal((await create(admin, { url: valid.url })).status, 400);
    });

    it('removes duplicate events', async () => {
      const res = await create(admin, { url: valid.url, events: ['booking.confirmed', 'booking.confirmed'] });
      assert.deepEqual(res.body.data.webhook.events, ['booking.confirmed']);
    });

    it('disables, re-enables (clearing the failure streak) and deletes', async () => {
      const { body } = await create(admin, valid);
      const id = body.data.webhook.id;
      await prisma.webhookEndpoint.update({ where: { id }, data: { failureCount: 4 } });

      const off = await request(app).patch(`/api/webhooks/${id}`).set(bearer(admin)).send({ active: false });
      assert.equal(off.body.data.webhook.active, false);

      const on = await request(app).patch(`/api/webhooks/${id}`).set(bearer(admin)).send({ active: true });
      assert.equal(on.body.data.webhook.active, true);
      assert.equal(on.body.data.webhook.failureCount, 0);

      assert.equal((await request(app).patch(`/api/webhooks/${id}`).set(bearer(admin)).send({})).status, 400);
      assert.equal((await request(app).delete(`/api/webhooks/${id}`).set(bearer(admin))).status, 204);
      assert.equal((await request(app).delete(`/api/webhooks/${id}`).set(bearer(admin))).status, 404);
    });

    it('queues a ping, but not for a disabled endpoint', async () => {
      const { body } = await create(admin, valid);
      const id = body.data.webhook.id;

      const ping = await request(app).post(`/api/webhooks/${id}/test`).set(bearer(admin));
      assert.equal(ping.status, 202);
      assert.ok(ping.body.data.deliveryId);

      await request(app).patch(`/api/webhooks/${id}`).set(bearer(admin)).send({ active: false });
      assert.equal((await request(app).post(`/api/webhooks/${id}/test`).set(bearer(admin))).status, 409);
    });
  });

  // -------------------------------------------------------------------------
  describe('dispatch (who gets which event)', () => {
    it('queues one delivery per active, subscribed endpoint', async () => {
      const make = (events, active = true) =>
        prisma.webhookEndpoint.create({
          data: { url: 'http://localhost:1/x', secret: 's', events, active, createdById: admin.id },
        });
      const yes1 = await make(['booking.confirmed']);
      const yes2 = await make(['booking.confirmed', 'event.finished']);
      await make(['event.finished']); // not subscribed to this event
      await make(['booking.confirmed'], false); // subscribed but switched off

      const queued = [];
      const count = await dispatchWebhook('booking.confirmed', { bookingId: 'b1' }, {
        enqueue: async (job) => queued.push(job),
      });

      assert.equal(count, 2);
      assert.deepEqual(queued.map((j) => j.endpointId).sort(), [yes1.id, yes2.id].sort());

      const job = queued[0];
      assert.equal(job.event, 'booking.confirmed');
      assert.equal(job.payload.id, job.deliveryId); // envelope id = delivery id
      assert.equal(job.payload.event, 'booking.confirmed');
      assert.deepEqual(job.payload.data, { bookingId: 'b1' });
      assert.notEqual(queued[0].deliveryId, queued[1].deliveryId);
    });

    it('never throws, even if queueing fails', async () => {
      await prisma.webhookEndpoint.create({
        data: { url: 'http://localhost:1/x', secret: 's', events: ['booking.confirmed'], createdById: admin.id },
      });
      const result = await dispatchWebhook('booking.confirmed', {}, {
        enqueue: async () => {
          throw new Error('redis exploded');
        },
      });
      assert.equal(result, 0);
    });
  });

  // -------------------------------------------------------------------------
  describe('delivery', () => {
    let receiver;
    let endpoint;

    beforeEach(async () => {
      receiver = await startReceiver();
      endpoint = await prisma.webhookEndpoint.create({
        data: { url: receiver.url, secret: generateSecret(), events: ['booking.confirmed'], createdById: admin.id },
      });
    });
    const finish = () => receiver.close();

    const job = (overrides = {}) => {
      const deliveryId = crypto.randomUUID();
      return {
        endpointId: endpoint.id,
        deliveryId,
        event: 'booking.confirmed',
        payload: buildEnvelope(deliveryId, 'booking.confirmed', { bookingId: 'b1', quantity: 2 }),
        ...overrides,
      };
    };

    it('POSTs signed JSON that the receiver can verify', async () => {
      const { records, record } = noRecord();
      const data = job();

      const result = await deliverWebhook(data, { record, allowPrivate: true });
      await finish();

      assert.equal(result.status, 200);
      assert.equal(receiver.received.length, 1);

      const { headers, body, method } = receiver.received[0];
      assert.equal(method, 'POST');
      assert.equal(headers['content-type'], 'application/json');
      assert.equal(headers['x-webhook-id'], data.deliveryId);
      assert.equal(headers['x-webhook-event'], 'booking.confirmed');
      assert.deepEqual(JSON.parse(body), data.payload);
      assert.equal(
        verifySignature({
          secret: endpoint.secret,
          timestamp: headers['x-webhook-timestamp'],
          body,
          signature: headers['x-webhook-signature'],
        }),
        true,
      );
      assert.equal(records[0].status, 'SUCCESS');
    });

    it('throws on a non-2xx answer so the queue retries, and logs it as RETRYING', async () => {
      receiver.state.respond = (req, res) => res.writeHead(500).end('boom');
      const { records, record } = noRecord();

      await assert.rejects(
        deliverWebhook(job(), { record, allowPrivate: true, attempt: 1, maxAttempts: 3 }),
        /HTTP 500/,
      );
      await finish();

      assert.equal(records[0].status, 'RETRYING');
      assert.equal(records[0].lastStatusCode, 500);
      const after = await prisma.webhookEndpoint.findUnique({ where: { id: endpoint.id } });
      assert.equal(after.failureCount, 0); // a retry is not yet a final failure
    });

    it('does not follow redirects', async () => {
      receiver.state.respond = (req, res) => res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }).end();
      const { record } = noRecord();

      await assert.rejects(deliverWebhook(job(), { record, allowPrivate: true }), /HTTP 302/);
      await finish();
      assert.equal(receiver.received.length, 1); // only our one request, nothing followed
    });

    it('treats a receiver that never answers as a failed attempt', async () => {
      receiver.state.respond = () => {}; // hang
      const { records, record } = noRecord();

      await assert.rejects(
        deliverWebhook(job(), { record, allowPrivate: true, timeoutMs: 300 }),
        /no response within 300ms/,
      );
      await finish();
      assert.equal(records[0].status, 'RETRYING');
    });

    it('counts a final failure, and disables the endpoint after 5 in a row', async () => {
      receiver.state.respond = (req, res) => res.writeHead(503).end();
      const { records, record } = noRecord();
      await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { failureCount: 3 } });

      // last attempt of delivery number 4: counted, still active
      await assert.rejects(deliverWebhook(job(), { record, allowPrivate: true, attempt: 3, maxAttempts: 3 }));
      let row = await prisma.webhookEndpoint.findUnique({ where: { id: endpoint.id } });
      assert.equal(row.failureCount, 4);
      assert.equal(row.active, true);
      assert.equal(records.at(-1).status, 'FAILED');

      // delivery number 5: reaches the limit, endpoint switched off
      await assert.rejects(deliverWebhook(job(), { record, allowPrivate: true, attempt: 3, maxAttempts: 3 }));
      row = await prisma.webhookEndpoint.findUnique({ where: { id: endpoint.id } });
      assert.equal(row.failureCount, 5);
      assert.equal(row.active, false);
      await finish();
    });

    it('a success resets the failure streak', async () => {
      await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { failureCount: 4 } });
      const { record } = noRecord();

      await deliverWebhook(job(), { record, allowPrivate: true });
      await finish();

      const row = await prisma.webhookEndpoint.findUnique({ where: { id: endpoint.id } });
      assert.equal(row.failureCount, 0);
    });

    it('skips (without retrying) when the endpoint was disabled or deleted meanwhile', async () => {
      const { records, record } = noRecord();
      await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { active: false } });

      const result = await deliverWebhook(job(), { record, allowPrivate: true });
      assert.deepEqual(result, { skipped: true });
      assert.equal(records[0].status, 'SKIPPED');

      await prisma.webhookEndpoint.delete({ where: { id: endpoint.id } });
      assert.deepEqual(await deliverWebhook(job(), { record, allowPrivate: true }), { skipped: true });
      await finish();
      assert.equal(receiver.received.length, 0); // nothing was ever sent
    });

    it('blocks a private target when private targets are not allowed', async () => {
      const { records, record } = noRecord();

      await assert.rejects(
        deliverWebhook(job(), { record, allowPrivate: false, attempt: 1, maxAttempts: 3 }),
        /Blocked/,
      );
      await finish();
      assert.equal(receiver.received.length, 0);
      assert.match(records[0].lastError, /Blocked/);
    });
  });

  // -------------------------------------------------------------------------
  describe('cron: event.finished', () => {
    it('marks past events FINISHED and leaves future ones alone', async () => {
      const make = (title, date) =>
        prisma.event.create({ data: { title, city: 'Raipur', date, price: 1, totalSeats: 5, seatsLeft: 5 } });
      const past = await make('Past', new Date(Date.now() - 3_600_000));
      const future = await make('Future', new Date(Date.now() + 86_400_000));

      assert.equal(await markFinishedEvents(), 1);
      assert.equal((await prisma.event.findUnique({ where: { id: past.id } })).status, 'FINISHED');
      assert.equal((await prisma.event.findUnique({ where: { id: future.id } })).status, 'UPCOMING');
      assert.equal(await markFinishedEvents(), 0); // running it again changes nothing
    });
  });
});
