// This file handles ERRORS for the whole app. Every error from any route or
// middleware ends up here, so users always get a clean JSON reply instead of
// a crash or an ugly stack trace.
// It exports 2 middlewares. Register them LAST in your Express app:
//   app.use(notFound);
//   app.use(errorHandler);

import AppError from "../utils/AppError.js";
import { NODE_ENV } from "../config/env.js";
import logger from "../utils/logger.js";

export const notFound = (req, res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
};

export const errorHandler = (err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    err = new AppError("Invalid JSON body", 400);
  }

  if (err.isOperational) {
    return res.status(err.statusCode).json({
      status: "error",
      message: err.message,
      ...(err.details && { details: err.details }),
    });
  }

  logger.error(err);
  res.status(500).json({
    status: "error",
    message: "Internal server error",
    ...(NODE_ENV !== "production" && { stack: err.stack }),
  });
};
