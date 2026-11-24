// npm run mail:check -- someone@example.com [mood|all]: sends a code email (sample code 123456) through the SMTP settings in
// .env, in one mood, every mood ("all", one every 10 seconds), or the default. Prints only ok or what failed, never the password.
import { loadConfig } from '../src/config.ts';
import { codeMail, DEFAULT_MOOD, MOODS, smtpMailer } from '../src/mail.ts';

const [to, which = DEFAULT_MOOD] = process.argv.slice(2);
if (!to || (which !== 'all' && !MOODS.includes(which as never)))
  throw new Error(`Usage: npm run mail:check -- someone@example.com [${MOODS.join('|')}|all]`);
const send = smtpMailer(loadConfig());
// ponytail: a fixed gap between sends, since free SMTP plans (Mailtrap's) refuse bursts. Shorten it on a paid plan.
const GAP_MS = 10_000;
const moods = which === 'all' ? MOODS : [which];
for (const [i, mood] of moods.entries()) {
  if (i) await new Promise((r) => setTimeout(r, GAP_MS));
  const m = codeMail('verify', '123456', 15, mood);
  await send({ to, ...m, subject: `${m.subject} (${mood})` });
  console.log(`Mail ok: ${mood} sent to ${to}`);
}
