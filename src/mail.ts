// Outgoing email. The app takes a Mailer, so tests capture messages and production sends through SMTP (Mailtrap locally, Resend or similar live).
import nodemailer from 'nodemailer';
import type { Config } from './config.ts';

export type Mail = { to: string; subject: string; text: string };
export type Mailer = (m: Mail) => Promise<void>;

export function smtpMailer(cfg: Config): Mailer {
  const t = nodemailer.createTransport(cfg.smtpUrl);
  return async (m) => {
    await t.sendMail({ from: cfg.mailFrom, ...m });
  };
}
