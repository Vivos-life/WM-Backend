// npm run migrate: brings the database in DATABASE_URL up to date.
import { loadConfig } from './config.ts';
import { connect, migrate } from './db.ts';

const db = connect(loadConfig().databaseUrl);
try {
  const ran = await migrate(db);
  console.log(ran.length ? `Applied ${ran.join(', ')}` : 'Up to date');
} finally {
  await db.end();
}
