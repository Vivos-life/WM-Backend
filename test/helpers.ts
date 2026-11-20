// Test-only. A fresh, migrated test database and an app on it, with no network port.
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { connect, migrate } from '../src/db.ts';
import type { Mail } from '../src/mail.ts';

// Tests need no .env: they default to the docker-compose database. Mail is captured, never sent.
process.env.TEST_DATABASE_URL ??= 'postgres://wm:wm-dev-only@127.0.0.1:5544/wm_test';
process.env.SMTP_URL ??= 'smtp://unused.invalid';
process.env.MAIL_FROM ??= 'What Matters <test@example.com>';

export async function fresh(over: Partial<Config> = {}) {
  const cfg = { ...loadConfig('test'), ...over };
  const db = connect(cfg.databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(db);
  const sent: Mail[] = [];
  const app = await buildApp(db, cfg, async (m) => {
    sent.push(m);
  });
  app.log.level = 'silent';
  const close = async () => {
    await app.close();
    await db.end();
  };
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: object, token?: string) =>
    app.inject({ method, url, payload: body, headers: token ? { authorization: 'Bearer ' + token } : {} });
  /** The 6-digit code in the latest email to this address. Mail goes out after the reply, so it waits a tick first. */
  const codeFor = async (email: string) => {
    await new Promise((r) => setImmediate(r));
    const m = sent.findLast((x) => x.to === email);
    return m ? /\b(\d{6})\b/.exec(m.text)![1] : null;
  };
  /** A new account, verified with its emailed code: the signed-in tokens. */
  const register = async (email = 'alex@example.com', password = 'correct horse') => {
    await call('POST', '/auth/register', { email, password });
    return (await call('POST', '/auth/verify', { email, code: await codeFor(email) })).json();
  };
  return { app, db, cfg, call, register, codeFor, close, sent };
}
