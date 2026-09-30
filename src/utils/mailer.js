import nodemailer from 'nodemailer';
import { SMTP_URL, EMAIL_FROM } from '../config/env.js';
import logger from './logger.js';

// With SMTP_URL set (e.g. smtps://user:pass@smtp.gmail.com), real emails are sent.
// Without it, jsonTransport builds the email but sends nothing: safe for development.
const transporter = nodemailer.createTransport(SMTP_URL ?? { jsonTransport: true });

export async function sendEmail({ to, subject, text }) {
  const info = await transporter.sendMail({ from: EMAIL_FROM, to, subject, text });

  if (!SMTP_URL) {
    logger.info(`[email:dev] to=${to} | subject="${subject}"\n${text}`);
  }
  return info;
}
