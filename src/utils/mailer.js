// This file sends EMAILS. It uses nodemailer, a library that helps Node.js
// send mail through an email server (SMTP).
// It exports one function: sendEmail({ to, subject, text }).
// The email worker (worker.js) calls it after a booking is confirmed,
// cancelled, or expired.

import nodemailer from "nodemailer";
import { SMTP_URL, EMAIL_FROM } from "../config/env.js";
import logger from "./logger.js";

const transporter = nodemailer.createTransport(
  SMTP_URL ?? { jsonTransport: true },
);

export async function sendEmail({ to, subject, text }) {
  const info = await transporter.sendMail({
    from: EMAIL_FROM,
    to,
    subject,
    text,
  });

  if (!SMTP_URL) {
    logger.info(`[email:dev] to=${to} | subject="${subject}"\n${text}`);
  }
  return info;
}
