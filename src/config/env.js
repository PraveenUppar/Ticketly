// This file reads your .env file, checks that every value is correct,
// and exports them as variables the rest of your app can import.
// If a value is missing or wrong, the app stops at startup with a clear error
// instead of crashing later in a confusing way.
//
// How it works:
//   1. dotenv loads the .env file into process.env
//   2. zod (a validation library) checks each value against the rules below
//   3. If any check fails, errors are printed and the app exits
//   4. If all pass, the values are exported (import { PORT } from "./env")
//
// What each value is for:
//   PORT                    port your server runs on (default 3000)
//   NODE_ENV                development, test, or production
//   DATABASE_URL            MySQL connection string (required, used by Prisma)
//   MONGO_URL               MongoDB connection string (default: local MongoDB)
//   REDIS_URL               Redis connection string (default: local Redis)
//   SMTP_URL                email server (optional, without it emails are printed in the console)
//   EMAIL_FROM              the "from" name and address on emails
//   JWT_SECRET              secret key used to sign login tokens (min 16 characters)
//   JWT_EXPIRES_IN          how long a login token stays valid (default 1 day)
//   PAYMENT_PROVIDER        "fake" is a pretend provider for learning, no real money
//   PAYMENT_WEBHOOK_SECRET  secret used to check that payment webhooks are genuine
//   BOOKING_HOLD_MINUTES    how long unpaid seats are held before being released
//   CURRENCY                3-letter currency code (default INR)

import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z
    .string()
    .startsWith("mysql://", "DATABASE_URL must be a mysql:// URL"),
  MONGO_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .startsWith("mongodb", "MONGO_URL must be a mongodb:// URL")
      .default("mongodb://127.0.0.1:27017/event_booking"),
  ),
  REDIS_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .startsWith("redis", "REDIS_URL must be a redis:// URL")
      .default("redis://127.0.0.1:6379"),
  ),
  SMTP_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().optional(),
  ),
  EMAIL_FROM: z.string().default("Event Booking <no-reply@eventbooking.local>"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("1d"),

  // Payments. "fake" is a stand-in provider for learning and tests: no money, no account.
  PAYMENT_PROVIDER: z.enum(["fake"]).default("fake"),
  PAYMENT_WEBHOOK_SECRET: z
    .string()
    .min(16)
    .default("dev-only-fake-payment-webhook-secret"),
  BOOKING_HOLD_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  CURRENCY: z.string().length(3).default("INR"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  process.exit(1);
}

export const {
  PORT,
  NODE_ENV,
  DATABASE_URL,
  MONGO_URL,
  REDIS_URL,
  SMTP_URL,
  EMAIL_FROM,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  PAYMENT_PROVIDER,
  PAYMENT_WEBHOOK_SECRET,
  BOOKING_HOLD_MINUTES,
  CURRENCY,
} = parsed.data;
