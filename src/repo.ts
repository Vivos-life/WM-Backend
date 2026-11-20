// Every read and write of the database goes through this file: no other file runs SQL (test/repo.test.ts checks).
// That makes it the one place to add encryption at rest, the server-side twin of the phone's vault (mobile/src/store/vault.ts).
//
// The at-rest lock: lock() runs on every sensitive value on its way into the database, unlock() on its way out.
// Today they change nothing: the VPS disk is encrypted, and household records arrive already sealed by the phone.
// To encrypt columns in the database: implement them here (for example AES-256-GCM with a key from the environment, versioned
// so old rows still open), and add a migration. Emails would also need a separate lookup column (an HMAC of the email),
// because an encrypted email can't be matched with "WHERE email = $1". Nothing outside this file changes.
import type { Db } from './db.ts';

const lock = (b: Buffer): Buffer => b;
const unlock = (b: Buffer): Buffer => b;
const lockText = (s: string) => lock(Buffer.from(s, 'utf8')).toString('utf8');

export type NewSession = { accessHash: Buffer; accessExpires: Date; refreshHash: Buffer; refreshExpires: Date };
export type CodePurpose = 'reset' | 'verify';
export type Blob = { kind: string; version: number; envelope: Buffer; updatedAt: Date };

export function createRepo(db: Db) {
  /** Runs fn in one transaction. */
  async function tx<T>(fn: (q: Db['query']) => Promise<T>): Promise<T> {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c.query.bind(c) as Db['query']);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  const insertSession = (q: Db['query'], userId: string, family: string, s: NewSession) =>
    q(
      'INSERT INTO sessions (user_id, family, access_hash, access_expires, refresh_hash, refresh_expires) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, family, s.accessHash, s.accessExpires, s.refreshHash, s.refreshExpires],
    );

  return {
    health: () => db.query('SELECT 1'),

    // ---- Accounts
    /** The new user's id, or null if the email already has an account. */
    async createUser(email: string, passwordHash: string): Promise<string | null> {
      const { rows } = await db.query<{ id: string }>(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id',
        [lockText(email), passwordHash],
      );
      return rows[0]?.id ?? null;
    },
    async userByEmail(email: string): Promise<{ id: string; passwordHash: string; verified: boolean } | null> {
      const { rows } = await db.query<{ id: string; password_hash: string; verified: boolean }>(
        'SELECT id, password_hash, verified_at IS NOT NULL AS verified FROM users WHERE email = $1',
        [lockText(email)],
      );
      return rows[0] ? { id: rows[0].id, passwordHash: rows[0].password_hash, verified: rows[0].verified } : null;
    },
    async passwordHashOf(userId: string): Promise<string | null> {
      const { rows } = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [
        userId,
      ]);
      return rows[0]?.password_hash ?? null;
    },
    /** The email is confirmed: the account can sign in. Its verify code is spent. */
    verifyEmail: (userId: string) =>
      tx(async (q) => {
        await q('UPDATE users SET verified_at = coalesce(verified_at, now()) WHERE id = $1', [userId]);
        await q("DELETE FROM codes WHERE user_id = $1 AND purpose = 'verify'", [userId]);
      }),
    /** When the account is due to be deleted, or null. */
    async deleteAt(userId: string): Promise<Date | null> {
      const { rows } = await db.query<{ delete_at: Date | null }>('SELECT delete_at FROM users WHERE id = $1', [
        userId,
      ]);
      return rows[0]?.delete_at ?? null;
    },
    /** Schedules deletion `days` from now, or cancels it (null). Asking again keeps the first date. The date, or null. */
    async scheduleDelete(userId: string, days: number | null): Promise<Date | null> {
      const { rows } = await db.query<{ delete_at: Date | null }>(
        days === null
          ? 'UPDATE users SET delete_at = NULL WHERE id = $1 RETURNING delete_at'
          : 'UPDATE users SET delete_at = coalesce(delete_at, now() + make_interval(days => $2)) WHERE id = $1 RETURNING delete_at',
        days === null ? [userId] : [userId, days],
      );
      return rows[0]?.delete_at ?? null;
    },
    /** Deletes every account whose date has come: sessions, codes and household records go with it (ON DELETE CASCADE). How many. */
    async purgeDeleted(): Promise<number> {
      const { rowCount } = await db.query('DELETE FROM users WHERE delete_at <= now()');
      return rowCount ?? 0;
    },

    // ---- Sessions
    createSession: (userId: string, family: string, s: NewSession) =>
      insertSession(db.query.bind(db) as Db['query'], userId, family, s),
    async sessionUser(accessHash: Buffer): Promise<string | null> {
      const { rows } = await db.query<{ user_id: string }>(
        'SELECT user_id FROM sessions WHERE access_hash = $1 AND access_expires > now() AND rotated_at IS NULL AND revoked_at IS NULL',
        [accessHash],
      );
      return rows[0]?.user_id ?? null;
    },
    /** Swaps a refresh token for `next`. A rotated token presented again was copied: its whole session family is revoked. */
    rotateSession: (refreshHash: Buffer, next: NewSession) =>
      tx(async (q) => {
        const { rows } = await q<{ id: string; user_id: string; family: string; rotated: boolean; live: boolean }>(
          `SELECT id, user_id, family, rotated_at IS NOT NULL AS rotated, revoked_at IS NULL AND refresh_expires > now() AS live
           FROM sessions WHERE refresh_hash = $1 FOR UPDATE`,
          [refreshHash],
        );
        const s = rows[0];
        if (s?.rotated)
          await q('UPDATE sessions SET revoked_at = now() WHERE family = $1 AND revoked_at IS NULL', [s.family]);
        if (!s || s.rotated || !s.live) return false;
        await q('UPDATE sessions SET rotated_at = now() WHERE id = $1', [s.id]);
        await insertSession(q, s.user_id, s.family, next);
        return true;
      }),
    endSessionOf: (accessHash: Buffer) =>
      db.query(
        'UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL AND family = (SELECT family FROM sessions WHERE access_hash = $1)',
        [accessHash],
      ),

    // ---- Emailed codes (reset a password, verify an email)
    putCode: (userId: string, purpose: CodePurpose, codeHash: Buffer, expires: Date) =>
      db.query(
        `INSERT INTO codes (user_id, purpose, code_hash, expires_at) VALUES ($1, $2, $3, $4)
                ON CONFLICT (user_id, purpose) DO UPDATE SET code_hash = $3, expires_at = $4, attempts = 0`,
        [userId, purpose, codeHash, expires],
      ),
    /** Checks a code; a wrong one uses up a try. The user's id when the code is right and still live, else null. */
    async useCode(email: string, purpose: CodePurpose, codeHash: Buffer): Promise<string | null> {
      const { rows } = await db.query<{ user_id: string; ok: boolean; live: boolean }>(
        `SELECT c.user_id, c.code_hash = $3 AS ok, c.expires_at > now() AND c.attempts < 5 AS live
           FROM codes c JOIN users u ON u.id = c.user_id WHERE u.email = $1 AND c.purpose = $2`,
        [lockText(email), purpose, codeHash],
      );
      const r = rows[0];
      if (r && r.live && !r.ok)
        await db.query('UPDATE codes SET attempts = attempts + 1 WHERE user_id = $1 AND purpose = $2', [
          r.user_id,
          purpose,
        ]);
      return r && r.live && r.ok ? r.user_id : null;
    },
    /** New password, codes spent, every session ended: all or nothing. The code came by email, so the email counts as verified. */
    resetPassword: (userId: string, passwordHash: string) =>
      tx(async (q) => {
        await q('UPDATE users SET password_hash = $2, verified_at = coalesce(verified_at, now()) WHERE id = $1', [
          userId,
          passwordHash,
        ]);
        await q('DELETE FROM codes WHERE user_id = $1', [userId]);
        await q('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      }),

    // ---- Household records (sealed on the phone)
    async blobs(userId: string): Promise<Blob[]> {
      const { rows } = await db.query<{ kind: string; version: number; envelope: Buffer; updated_at: Date }>(
        'SELECT kind, version, envelope, updated_at FROM blobs WHERE user_id = $1 ORDER BY kind',
        [userId],
      );
      return rows.map((r) => ({
        kind: r.kind,
        version: r.version,
        envelope: unlock(r.envelope),
        updatedAt: r.updated_at,
      }));
    },
    /** Saves over exactly `version` (0 for the first save). The new version, or the current one as a conflict. */
    async putBlob(
      userId: string,
      kind: string,
      version: number,
      envelope: Buffer,
    ): Promise<{ version: number } | { conflict: number }> {
      const sealed = lock(envelope);
      const { rowCount } =
        version === 0
          ? await db.query(
              'INSERT INTO blobs (user_id, kind, version, envelope) VALUES ($1, $2, 1, $3) ON CONFLICT DO NOTHING',
              [userId, kind, sealed],
            )
          : await db.query(
              'UPDATE blobs SET version = $4, envelope = $3, updated_at = now() WHERE user_id = $1 AND kind = $2 AND version = $5',
              [userId, kind, sealed, version + 1, version],
            );
      if (rowCount) return { version: version + 1 };
      const cur = await db.query<{ version: number }>('SELECT version FROM blobs WHERE user_id = $1 AND kind = $2', [
        userId,
        kind,
      ]);
      return { conflict: cur.rows[0]?.version ?? 0 };
    },
  };
}
export type Repo = ReturnType<typeof createRepo>;
