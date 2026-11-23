// Outgoing email. The app takes a Mailer, so tests capture messages and production sends through SMTP (Mailtrap locally, Resend or similar live).
import nodemailer from 'nodemailer';
import type { Config } from './config.ts';

export type Mail = { to: string; subject: string; text: string };
export type Mailer = (m: Mail) => Promise<void>;

export function smtpMailer(cfg: Config): Mailer {
  const { host, port, user, pass } = cfg.smtp;
  // Port 465 speaks TLS from the start; 587 and 2525 upgrade to it (STARTTLS), and requireTLS refuses to send without it.
  const t = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass },
  });
  return async (m) => {
    await t.sendMail({ from: cfg.mailFrom, ...m });
  };
}
