// This is a MIDDLEWARE that checks WHAT a user is allowed to do (authorization).
// It lets only users with certain roles continue. Everyone else gets a 403 error.
//
// Difference from requireAuth:
//   requireAuth   "Are you logged in?"      -> 401 if not
//   requireRole   "Are you allowed to do this?" -> 403 if not
//
// How it works:
//   requireRole("ADMIN") returns a middleware function (a function that
//   makes a function). You pass the allowed roles when you set up the route.
//   Then, for each request:
//     1. If req.user is missing, the user is not logged in.
//        Stop with 401 "Authentication required".
//        (This happens if you forgot to put requireAuth before this one.)
//     2. If the user's role is not in the allowed list, stop with
//        403 "You do not have permission to do this".
//     3. Otherwise call next() and continue to the route handler.

import AppError from "../utils/AppError.js";

const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) return next(new AppError("Authentication required", 401));
    if (!roles.includes(req.user.role)) {
      return next(new AppError("You do not have permission to do this", 403));
    }
    next();
  };

export default requireRole;
