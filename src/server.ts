// npm start: migrates, serves, and deletes accounts whose deletion date has passed, with their photos.
import { buildApp } from './app.ts';
import { createRepo } from './repo.ts';
import { loadConfig } from './config.ts';
import { connect, migrate } from './db.ts';
import { smtpMailer } from './mail.ts';
import { purgeAccounts, r2Store } from './photos.ts';

const cfg = loadConfig();
const db = connect(cfg.databaseUrl);
await migrate(db);
const photos = r2Store(cfg.r2);
const app = await buildApp(db, cfg, smtpMailer(cfg), photos);
await app.listen({ host: cfg.host, port: cfg.port });

// Accounts past their deletion date are removed at start and every hour.
// ponytail: an in-process timer for one server; a system timer (cron, systemd) if it ever runs as several.
const repo = createRepo(db);
const purge = () =>
  purgeAccounts(repo, photos).then(
    (n) => {
      if (n) app.log.info({ deleted: n }, 'accounts deleted');
    },
    (e: Error) => app.log.error({ err: e.message }, 'purge failed'),
  );
await purge();
const purgeTimer = setInterval(purge, 3_600_000);
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, async () => {
    clearInterval(purgeTimer);
    await app.close();
    await db.end();
    process.exit(0);
  });
