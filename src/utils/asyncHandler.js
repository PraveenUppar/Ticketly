// This is a small HELPER that wraps your async route handlers, so any error
// inside them is sent to errorHandler.js automatically.

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export default asyncHandler;
