// This is a MIDDLEWARE that gives every request a unique ID (like a tracking number).
// With it, you can follow ONE request through all your logs, even when many
// users are calling the API at the same time.
//
// How it works:
//   1. Looks at the "x-request-id" header. A client or proxy may already send one.
//   2. If that ID is safe, it is reused. "Safe" means: 8 to 64 characters, and only
//      letters, numbers, "_" or "-" (SAFE_ID check).
//      Why check? A bad client could send a huge or strange value that breaks
//      your logs or sneaks in dangerous characters.
//   3. If the ID is missing or not safe, a new random one is created with randomUUID().
//   4. The ID is saved in 2 places:
//        req.id                       so route code can read it
//        "X-Request-Id" response header   so the client can see it too
//                                         (useful when a user reports a problem:
//                                         "my request id was abc123")
//   5. requestContext.run({ requestId: id }, next) continues the request inside a
//      "context". Every logger.info/error call later in this request automatically
//      includes the ID, without you passing it around by hand.
//      (This uses Node's AsyncLocalStorage under the hood.)

import { randomUUID } from "node:crypto";
import { requestContext } from "../utils/logger.js";

const SAFE_ID = /^[\w-]{8,64}$/;

const requestId = (req, res, next) => {
  const incoming = req.headers["x-request-id"];
  const id = SAFE_ID.test(incoming ?? "") ? incoming : randomUUID();

  req.id = id;
  res.setHeader("X-Request-Id", id);

  requestContext.run({ requestId: id }, next);
};

export default requestId;
