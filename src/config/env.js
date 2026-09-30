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
  // Optional. Without it, emails are NOT sent: they are printed to the console instead.
  SMTP_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  EMAIL_FROM: z.string().default("Event Booking <no-reply@eventbooking.local>"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("1d"),

  // Payments. "fake" is a stand-in provider for learning and tests: no money, no account.
  PAYMENT_PROVIDER: z.enum(["fake"]).default("fake"),
  // Shared secret used to verify webhooks from the payment provider.
  PAYMENT_WEBHOOK_SECRET: z.string().min(16).default("dev-only-fake-payment-webhook-secret"),
  // How long unpaid seats are held before they are released.
  BOOKING_HOLD_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  CURRENCY: z.string().length(3).default("INR"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

// The fake provider accepts anything signed with a known dev secret, so it must never run for real.
if (parsed.data.NODE_ENV === "production" && parsed.data.PAYMENT_PROVIDER === "fake") {
  console.error("PAYMENT_PROVIDER=fake is not allowed in production. Configure a real provider.");
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
