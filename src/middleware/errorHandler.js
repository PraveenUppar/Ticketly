import AppError from "../utils/AppError.js";
import { NODE_ENV } from "../config/env.js";
import logger from '../utils/logger.js';

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
