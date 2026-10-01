// This is a CUSTOM ERROR class. Use it whenever you want to stop a request on
// purpose and tell the user what went wrong, with the right HTTP status code.
// (A class is a blueprint for making objects. This one extends Error, so it
// works like a normal JavaScript error with extra information added.)

class AppError extends Error {
  constructor(message, statusCode = 500, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export default AppError;
