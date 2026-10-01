// This is a simple LOGGER. It prints messages to the console in a clean format.
// Each line shows the time, the level, and the request ID, so you can follow
// one request through all your logs.
// Other files use it like this:  logger.info("Server started")

import { AsyncLocalStorage } from "node:async_hooks";
export const requestContext = new AsyncLocalStorage();

export const currentRequestId = () => requestContext.getStore()?.requestId;

function write(level, args) {
  const id = currentRequestId() ?? "-";
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${id}]`;
  const out =
    level === "ERROR"
      ? console.error
      : level === "WARN"
        ? console.warn
        : console.log;
  out(line, ...args);
}

const logger = {
  info: (...args) => write("INFO", args),
  warn: (...args) => write("WARN", args),
  error: (...args) => write("ERROR", args),
};

export default logger;
