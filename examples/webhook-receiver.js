// A minimal webhook RECEIVER, to try the feature end to end. This is what the other side
// (a partner's server) would run. It deliberately imports nothing from ../src: a real
// receiver only has the secret and the rules below.
//
//   1. Register it:    POST /api/webhooks  { "url": "http://localhost:4000/hook", "events": ["booking.confirmed"] }
//                      -> copy the "secret" from the response (it is shown only once)
//   2. Run it:         WEBHOOK_SECRET=whsec_... node examples/webhook-receiver.js
//   3. Trigger it:     POST /api/webhooks/<id>/test   (or make a booking)
import http from 'node:http';
import crypto from 'node:crypto';

const SECRET = process.env.WEBHOOK_SECRET;
const PORT = process.env.PORT ?? 4000;
const TOLERANCE_SECONDS = 300;

if (!SECRET) {
  console.error('Set WEBHOOK_SECRET to the secret you got when registering the webhook.');
  process.exit(1);
}

// Remember delivery ids we have already handled. Delivery is "at least once", so the same
// event can arrive twice (a retry after our answer got lost). A real app would keep this in a database.
const seen = new Set();

function isValid(req, rawBody) {
  const timestamp = req.headers['x-webhook-timestamp'];
  const signature = req.headers['x-webhook-signature'] ?? '';

  // 1) reject old timestamps: stops someone replaying a captured request later
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return false;

  // 2) recompute the signature over the RAW body, exactly as received
  //    (parsing and re-serialising the JSON could change the bytes and break the match)
  const expected = `sha256=${crypto.createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex')}`;

  // 3) constant-time comparison
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || !isValid(req, raw)) {
        console.log('REJECTED (bad signature or timestamp)');
        return res.writeHead(401).end('invalid signature');
      }

      const event = JSON.parse(raw);
      if (seen.has(event.id)) {
        console.log(`duplicate delivery ${event.id}, ignoring`);
        return res.writeHead(200).end('already processed');
      }
      seen.add(event.id);

      console.log(`OK  ${event.event}  (delivery ${event.id})`);
      console.log(JSON.stringify(event.data, null, 2));

      // Answer fast with a 2xx. Do slow work AFTER responding (or queue it): if we take longer
      // than the sender's timeout, it treats the delivery as failed and retries.
      res.writeHead(200).end('ok');
    });
  })
  .listen(PORT, () => console.log(`Webhook receiver listening on http://localhost:${PORT}/hook`));
