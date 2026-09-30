import { AsyncLocalStorage } from 'node:async_hooks';

// AsyncLocalStorage = "thread-local storage" for async code. Anything that runs as part of
// one request (controllers, services, Prisma calls, even code after an `await`) can read
// the same store. That's how EVERY log line gets the request ID without passing `req`
// through every function.
export const requestContext = new AsyncLocalStorage();

export const currentRequestId = () => requestContext.getStore()?.requestId;

function write(level, args) {
  const id = currentRequestId() ?? '-';
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${id}]`;
  const out = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  out(line, ...args);
}

const logger = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
};

export default logger;
