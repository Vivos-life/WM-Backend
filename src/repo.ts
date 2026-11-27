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
const unlockText = (s: string) => unlock(Buffer.from(s, 'utf8')).toString('utf8');

/** How long a refresh token that was just used may be used again (the phone never got the answer: signal lost, app closed). */
const RETRY_SECONDS = 30;
export type NewSession = { accessHash: Buffer; accessExpires: Date; refreshHash: Buffer; refreshExpires: Date };
/** A signed-in device: one session family. lastUsed is its latest refresh (or sign-in). */
export type Device = { id: string; name: string | null; lastUsed: Date; me: boolean };
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
  // device is already locked (a refresh copies it from the row it replaces).
  const insertSession = (q: Db['query'], userId: string, family: string, s: NewSession, device: string | null) =>
    q(
      'INSERT INTO sessions (user_id, family, access_hash, access_expires, refresh_hash, refresh_expires, device) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [userId, family, s.accessHash, s.accessExpires, s.refreshHash, s.refreshExpires, device],
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
    async userByEmail(
      email: string,
    ): Promise<{ id: string; passwordHash: string; verified: boolean; mood: string | null } | null> {
      const { rows } = await db.query<{ id: string; password_hash: string; verified: boolean; mood: string | null }>(
        'SELECT id, password_hash, verified_at IS NOT NULL AS verified, mood FROM users WHERE email = $1',
        [lockText(email)],
      );
      const r = rows[0];
      return r ? { id: r.id, passwordHash: r.password_hash, verified: r.verified, mood: r.mood } : null;
    },
    /** The colour mood the person chose in the app, which their emails use. */
    setMood: (userId: string, mood: string) => db.query('UPDATE users SET mood = $2 WHERE id = $1', [userId, mood]),
    async emailOf(userId: string): Promise<string | null> {
      const { rows } = await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
      return rows[0] ? unlockText(rows[0].email) : null;
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
    /** Deletes every account whose date has come: sessions, codes and household records go with it (ON DELETE CASCADE).
     *  The ids deleted, so their photos can go too. */
    async purgeDeleted(): Promise<string[]> {
      const { rows } = await db.query<{ id: string }>('DELETE FROM users WHERE delete_at <= now() RETURNING id');
      return rows.map((r) => r.id);
    },

    // ---- Sessions
    createSession: (userId: string, family: string, s: NewSession, device: string | null) =>
      insertSession(db.query.bind(db) as Db['query'], userId, family, s, device === null ? null : lockText(device)),
    async sessionUser(accessHash: Buffer): Promise<string | null> {
      const { rows } = await db.query<{ user_id: string }>(
        'SELECT user_id FROM sessions WHERE access_hash = $1 AND access_expires > now() AND rotated_at IS NULL AND revoked_at IS NULL',
        [accessHash],
      );
      return rows[0]?.user_id ?? null;
    },
    /** Swaps a refresh token for `next`. A rotated token presented again after RETRY_SECONDS was copied: its whole session
     *  family is revoked. Within them it is a retry of an answer that was lost on the way, and gets a new pair. */
    rotateSession: (refreshHash: Buffer, next: NewSession) =>
      tx(async (q) => {
        const { rows } = await q<{
          id: string;
          user_id: string;
          family: string;
          device: string | null;
          rotated: boolean;
          recent: boolean;
          live: boolean;
        }>(
          `SELECT id, user_id, family, device, rotated_at IS NOT NULL AS rotated,
                  rotated_at > now() - interval '${RETRY_SECONDS} seconds' AS recent,
                  revoked_at IS NULL AND refresh_expires > now() AS live
           FROM sessions WHERE refresh_hash = $1 FOR UPDATE`,
          [refreshHash],
        );
        const s = rows[0];
        if (!s) return false;
        if (s.rotated && !s.recent) {
          await q('UPDATE sessions SET revoked_at = now() WHERE family = $1 AND revoked_at IS NULL', [s.family]);
          return false;
        }
        if (!s.live) return false;
        // Inside the retry window a rotated token is the phone asking again because the answer never reached it: give a new
        // pair, and retire the one that was lost so the device still has a single live session.
        if (s.rotated)
          await q(
            'UPDATE sessions SET rotated_at = now() WHERE family = $1 AND rotated_at IS NULL AND revoked_at IS NULL',
            [s.family],
          );
        else await q('UPDATE sessions SET rotated_at = now() WHERE id = $1', [s.id]);
        await insertSession(q, s.user_id, s.family, next, s.device);
        return true;
      }),
    endSessionOf: (accessHash: Buffer) =>
      db.query(
        'UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL AND family = (SELECT family FROM sessions WHERE access_hash = $1)',
        [accessHash],
      ),

    /** The user's signed-in devices, latest first; me is the one holding accessHash. Each live family has one current row. */
    async devicesOf(userId: string, accessHash: Buffer): Promise<Device[]> {
      const { rows } = await db.query<{ family: string; device: string | null; created_at: Date; me: boolean }>(
        `SELECT family, device, created_at, access_hash = $2 AS me FROM sessions
         WHERE user_id = $1 AND rotated_at IS NULL AND revoked_at IS NULL AND refresh_expires > now()
         ORDER BY created_at DESC`,
        [userId, accessHash],
      );
      return rows.map((r) => ({
        id: r.family,
        name: r.device === null ? null : unlockText(r.device),
        lastUsed: r.created_at,
        me: r.me,
      }));
    },
    /** Signs out one of the user's devices. false if it isn't theirs or is already signed out. */
    async endFamily(userId: string, family: string): Promise<boolean> {
      const r = await db.query(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND family = $2 AND revoked_at IS NULL',
        [userId, family],
      );
      return (r.rowCount ?? 0) > 0;
    },

    // ---- Complaints
    /** Saves a complaint under its reference: when it was received. */
    async addComplaint(userId: string, ref: string, body: string): Promise<Date> {
      const { rows } = await db.query<{ created_at: Date }>(
        'INSERT INTO complaints (user_id, ref, body) VALUES ($1, $2, $3) RETURNING created_at',
        [userId, ref, lockText(body)],
      );
      return rows[0].created_at;
    },
    /** The user's complaints, newest first. */
    async complaintsOf(userId: string): Promise<{ ref: string; body: string; at: Date }[]> {
      const { rows } = await db.query<{ ref: string; body: string; created_at: Date }>(
        'SELECT ref, body, created_at FROM complaints WHERE user_id = $1 ORDER BY created_at DESC',
        [userId],
      );
      return rows.map((r) => ({ ref: r.ref, body: unlockText(r.body), at: r.created_at }));
    },

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
