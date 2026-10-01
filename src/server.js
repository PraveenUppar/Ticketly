import app from "./app.js";
import { PORT } from "./config/env.js";
import prisma from "./config/prisma.js";
import { connectMongo, disconnectMongo } from "./config/mongo.js";
import { cacheRedis, producerRedis } from "./config/redis.js";
import { closeQueues } from "./jobs/queue.js";
import { startWebhookWorker } from "./jobs/webhookWorker.js";
import { initSockets, closeSockets } from "./sockets/index.js";
import { startWorker } from "./jobs/worker.js";
import { startCron } from "./jobs/cron.js";
import logger from "./utils/logger.js";

try {
  await connectMongo();
} catch (err) {
  logger.error("Could not connect to MongoDB. Is it running?", err.message);
  process.exit(1);
}

const server = app.listen(PORT, () => {
  logger.info(`Server running on http://localhost:${PORT}`);
});

initSockets(server);

const worker = startWorker();
const webhookWorker = startWebhookWorker();
const cronTask = startCron();

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down...`);
  server.close();
  cronTask.stop();
  await Promise.all([worker.close(), webhookWorker.close()]);
  await closeSockets();
  await closeQueues();
  await Promise.allSettled([
    cacheRedis.quit(),
    producerRedis.quit(),
    prisma.$disconnect(),
    disconnectMongo(),
  ]);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
