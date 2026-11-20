// The HTTP app, built from a database and config so tests can run it without a network port.
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { authRoutes } from './auth.ts';
import { blobRoutes } from './blobs.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { createRepo } from './repo.ts';
import type { Mailer } from './mail.ts';

export async function buildApp(db: Db, cfg: Config, mail: Mailer) {
  // Logs never carry request bodies or headers: passwords, tokens and envelopes stay out of them (the Monzo PIN-in-logs lesson).
  const app = Fastify({ logger: { level: 'info', serializers: { req: (r) => ({ method: r.method, url: r.url }) } }, bodyLimit: 1_500_000,
    // Reject fields the API doesn't know, rather than silently dropping them.
    ajv: { customOptions: { removeAdditional: false } } });
  await app.register(rateLimit, { global: false });
  const repo = createRepo(db);
  app.get('/health', async () => {
    await repo.health();
    return { ok: true };
  });
  authRoutes(app, repo, cfg, mail);
  await app.register(blobRoutes(repo));
  return app;
}
