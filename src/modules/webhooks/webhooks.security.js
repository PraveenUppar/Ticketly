import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import AppError from '../../utils/AppError.js';
import { NODE_ENV } from '../../config/env.js';

// ---------------------------------------------------------------------------
// 1) SIGNING: lets the receiver prove a request really came from us.
//
//    signature = HMAC-SHA256(secret, "<timestamp>.<raw body>")
//
//    The timestamp is part of what is signed, so an attacker who captures one request
//    cannot replay it later: the receiver rejects timestamps older than a few minutes.
// ---------------------------------------------------------------------------

export function generateSecret() {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

export function signPayload(secret, timestamp, body) {
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `sha256=${digest}`;
}

// What a receiver runs. Exported so our tests (and the example receiver) use the same rule.
export function verifySignature({ secret, timestamp, body, signature, toleranceSeconds = 300 }) {
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const expected = Buffer.from(signPayload(secret, timestamp, body));
  const received = Buffer.from(String(signature ?? ''));

  // timingSafeEqual throws on different lengths, so compare lengths first.
  // It also compares in constant time, so an attacker can't guess the signature byte by byte.
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

// ---------------------------------------------------------------------------
// 2) SSRF PROTECTION. Admins choose the URL, and OUR server makes the request. Without
//    checks, a URL like http://169.254.169.254/ (cloud metadata) or http://localhost:3306
//    would make our server talk to things only it can reach.
// ---------------------------------------------------------------------------

const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes the cloud metadata address
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24],
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
].forEach(([address, prefix]) => blocked.addSubnet(address, prefix, 'ipv4'));
blocked.addAddress('::1', 'ipv6'); // loopback
blocked.addAddress('::', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6'); // unique local
blocked.addSubnet('fe80::', 10, 'ipv6'); // link-local
blocked.addSubnet('ff00::', 8, 'ipv6'); // multicast

export function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 0) return true; // not an IP at all: refuse rather than guess
  return blocked.check(ip, family === 6 ? 'ipv6' : 'ipv4'); // also covers ::ffff:127.0.0.1
}

// In development you will want to point webhooks at localhost. Never in production.
export const ALLOW_PRIVATE_TARGETS = NODE_ENV !== 'production';

const hostOf = (url) => url.hostname.replace(/^\[|\]$/g, ''); // strip [] around IPv6 literals

// Called when an admin registers a URL. Gives a clear error message up front.
export async function assertSafeWebhookUrl(rawUrl, { allowPrivate = ALLOW_PRIVATE_TARGETS } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('Webhook URL is not a valid URL', 400);
  }

  const allowedProtocols = allowPrivate ? ['https:', 'http:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol)) {
    throw new AppError('Webhook URL must use https', 400);
  }
  if (url.username || url.password) {
    throw new AppError('Webhook URL must not contain credentials', 400);
  }

  const host = hostOf(url);
  const addresses = net.isIP(host)
    ? [host]
    : await dns.promises
        .lookup(host, { all: true })
        .then((list) => list.map((entry) => entry.address))
        .catch(() => {
          throw new AppError(`Could not resolve host "${host}"`, 400);
        });

  if (!allowPrivate && addresses.some(isPrivateAddress)) {
    throw new AppError('Webhook URL points to a private or internal address', 400);
  }
  return url;
}

// Registration-time checks are not enough: DNS can change afterwards ("DNS rebinding":
// a name that resolved to a public IP when registered, then to 127.0.0.1 at delivery time).
// So we ALSO check at the exact moment the connection is made, using this lookup function.
export function makeSafeLookup(allowPrivate = ALLOW_PRIVATE_TARGETS) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);

      const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
      if (!allowPrivate && addresses.some(isPrivateAddress)) {
        return callback(new Error('Blocked: webhook target resolves to a private address'));
      }
      callback(null, address, family);
    });
  };
}

// Node skips DNS lookup entirely when the URL host is already an IP address,
// so IP literals need their own check.
export function assertHostAllowed(url, allowPrivate = ALLOW_PRIVATE_TARGETS) {
  const host = hostOf(url);
  if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) {
    throw new Error('Blocked: webhook target is a private address');
  }
}
