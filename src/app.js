import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import morgan from "morgan";
import requestId from "./middleware/requestId.js";
import { NODE_ENV } from "./config/env.js";
import authRoutes from "./modules/auth/auth.routes.js";
import eventRoutes from "./modules/events/events.routes.js";
import bookingRoutes from "./modules/bookings/bookings.routes.js";
import reviewRoutes from "./modules/reviews/reviews.routes.js";
import notificationRoutes from "./modules/notifications/notifications.routes.js";
import webhookRoutes from "./modules/webhooks/webhooks.routes.js";
import {
  paymentRoutes,
  fakeProviderRoutes,
} from "./modules/payments/payments.routes.js";
import { paymentProvider } from "./modules/payments/providers/index.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";

const app = express();

app.use(requestId);

app.use(
  "/api/payments/webhook",
  express.raw({ type: () => true, limit: "1mb" }),
);
app.use(express.json());
if (NODE_ENV !== "test") {
  app.use(
    morgan((tokens, req, res) =>
      [
        new Date().toISOString(),
        "HTTP ".padEnd(5),
        `[${req.id}]`,
        tokens.method(req, res),
        tokens.url(req, res),
        tokens.status(req, res),
        `${tokens["response-time"](req, res)}ms`,
      ].join(" "),
    ),
  );
}

app.use(
  express.static(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public"),
  ),
);

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.use("/api/auth", authRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api", reviewRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/payments", paymentRoutes);

if (paymentProvider.name === "fake") {
  app.use("/api/dev/fake-provider", fakeProviderRoutes);
}

app.use(notFound);
app.use(errorHandler);

export default app;
