import { randomUUID } from 'node:crypto';
import { requestContext } from '../utils/logger.js';

// Only trust a client-supplied ID if it looks harmless: a random string with newlines
// in it could forge fake log lines ("log injection").
const SAFE_ID = /^[\w-]{8,64}$/;

// Must be the FIRST middleware, so everything after it runs inside the request context.
const requestId = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const id = SAFE_ID.test(incoming ?? '') ? incoming : randomUUID();

  req.id = id;
  res.setHeader('X-Request-Id', id); // the client can quote this when reporting a problem

  requestContext.run({ requestId: id }, next);
};

export default requestId;
