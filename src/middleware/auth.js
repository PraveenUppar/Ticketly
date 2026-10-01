// This is a MIDDLEWARE that protects routes. It checks that the request comes
// from a logged-in user. If not, the request is stopped with a 401 error.
// (Middleware = a function that runs BEFORE your route handler.)
//
// How it works:
//   1. Reads the "Authorization" header of the request
//   2. The header must look like:  Authorization: Bearer <token>
//      If it is missing or does not start with "Bearer ", stop with
//      401 "Authentication required"
//   3. Cuts off the first 7 characters ("Bearer ") to get only the token
//   4. jwt.verify() checks the token using JWT_SECRET (from env.js):
//        - the signature is valid (the token was not changed by anyone)
//        - the token has not expired (JWT_EXPIRES_IN)
//      If the check fails, stop with 401 "Invalid or expired token"
//   5. If the token is good, save who the user is on the request:
//        req.user = { id, role }
//      (id comes from payload.sub, role is USER or ADMIN)
//   6. Call next() to continue to the next function (the route handler)

import jwt from "jsonwebtoken";
import AppError from "../utils/AppError.js";
import { JWT_SECRET } from "../config/env.js";

const requireAuth = (req, res, next) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return next(new AppError("Authentication required", 401));
  }

  const token = header.slice(7);

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    next(new AppError("Invalid or expired token", 401));
  }
};

export default requireAuth;
