// The Postgres pool, and the migration runner: every file in migrations/ runs once, in name order, inside a transaction.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export type Db = pg.Pool;
export const connect = (url: string): Db => new pg.Pool({ connectionString: url });

const dir = path.join(import.meta.dirname, '..', 'migrations');

export async function migrate(db: Db) {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const done = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const ran: string[] = [];
  for (const name of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (done.has(name)) continue;
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query(fs.readFileSync(path.join(dir, name), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await c.query('COMMIT');
      ran.push(name);
    } catch (e) {
      await c.query('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${(e as Error).message}`, { cause: e });
    } finally {
      c.release();
    }
  }
  return ran;
}
