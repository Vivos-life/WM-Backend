// npm run mail:check -- someone@example.com: sends one test email through the SMTP settings in .env. Prints only ok or what
// failed, never the password.
import { loadConfig } from '../src/config.ts';
import { smtpMailer } from '../src/mail.ts';

const to = process.argv[2];
if (!to) throw new Error('Usage: npm run mail:check -- someone@example.com');
await smtpMailer(loadConfig())({
  to,
  subject: 'What Matters mail check',
  text: 'This is a test from npm run mail:check.',
});
console.log('Mail ok: sent to ' + to);
