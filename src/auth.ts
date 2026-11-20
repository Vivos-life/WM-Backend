// Accounts and sessions. Passwords: argon2id. Tokens: 32 random bytes, sent once, stored only as SHA-256.
// Access lasts minutes; refresh rotates, and reusing an old one revokes the session. A new account signs in only after the
// 6-digit code sent to its email is entered; password reset uses the same kind of code. Deleting an account schedules it
// DELETE_DAYS out; until then it works as before and can be kept, and purgeDeleted (run by the server) removes it after.
// Errors never say whether an email has an account.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import type { CodePurpose, NewSession, Repo } from './repo.ts';
import type { Mailer } from './mail.ts';

const sha256 = (t: string) => createHash('sha256').update(t).digest();
const token = () => randomBytes(32).toString('base64url');

/** One address, one account: trimmed and lower-cased (the users table enforces the same). */
export const normEmail = (email: string) => email.trim().toLowerCase();
const INVALID = { error: 'invalid_credentials' };

// Verifying against this when the email is unknown keeps login equally slow either way, so timing doesn't reveal accounts.
const DUMMY = await hash('no account has this password');

/** Days between asking to delete an account and its deletion: the handoff's privacy notice and Privacy sheet promise 30. */
export const DELETE_DAYS = 30;

export type Tokens = { accessToken: string; refreshToken: string; accessExpiresAt: string };

/** A fresh token pair: the tokens for the phone, their hashes for the database. */
function pair(cfg: Config) {
  const a = token(), r = token(), now = Date.now();
  const row: NewSession = { accessHash: sha256(a), accessExpires: new Date(now + cfg.accessMs), refreshHash: sha256(r), refreshExpires: new Date(now + cfg.refreshMs) };
  const tokens: Tokens = { accessToken: a, refreshToken: r, accessExpiresAt: row.accessExpires.toISOString() };
  return { row, tokens };
}
async function issue(repo: Repo, cfg: Config, userId: string): Promise<Tokens> {
  const p = pair(cfg);
  await repo.createSession(userId, randomUUID(), p.row);
  return p.tokens;
}
const bearer = (req: FastifyRequest) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];

/** The signed-in user for a request's Bearer token, or null. */
export async function userOf(repo: Repo, req: FastifyRequest): Promise<string | null> {
  const t = bearer(req);
  return t ? repo.sessionUser(sha256(t)) : null;
}

// NCSC: length over complexity rules. The upper bound keeps hashing cheap for an attacker's huge inputs.
const credentials = {
  type: 'object', required: ['email', 'password'], additionalProperties: false,
  properties: { email: { type: 'string', format: 'email', maxLength: 254 }, password: { type: 'string', minLength: 8, maxLength: 128 } },
} as const;
const refreshBody = { type: 'object', required: ['refreshToken'], additionalProperties: false, properties: { refreshToken: { type: 'string', maxLength: 64 } } } as const;
type Creds = { email: string; password: string };
const email = { type: 'string', format: 'email', maxLength: 254 } as const, password = credentials.properties.password;
const emailBody = { type: 'object', required: ['email'], additionalProperties: false, properties: { email } } as const;
const code = { type: 'string', pattern: '^[0-9]{6}$' } as const;
const resetBody = { type: 'object', required: ['email', 'code', 'password'], additionalProperties: false, properties: { email, code, password } } as const;
const verifyBody = { type: 'object', required: ['email', 'code'], additionalProperties: false, properties: { email, code } } as const;
const deleteBody = { type: 'object', required: ['password'], additionalProperties: false, properties: { password } } as const;

export function authRoutes(app: FastifyInstance, repo: Repo, cfg: Config, mail: Mailer) {
  // Tight limits on the routes a password guesser would use.
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  // A fresh 6-digit code for the purpose, emailed after the reply (so its timing reveals nothing). A new one replaces the last.
  async function sendCode(req: FastifyRequest, userId: string, to: string, purpose: CodePurpose) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0'), minutes = Math.round(cfg.resetMs / 60_000);
    await repo.putCode(userId, purpose, sha256(code), new Date(Date.now() + cfg.resetMs));
    mail({ to, subject: 'Your What Matters code', text: CODE_TEXT[purpose](code, minutes) }).catch((e: Error) => req.log.error({ err: e.message }, purpose + ' email failed'));
  }

  app.post<{ Body: Creds }>('/auth/register', { ...limited, schema: { body: credentials } }, async (req, reply) => {
    const id = await repo.createUser(normEmail(req.body.email), await hash(req.body.password));
    // A taken email gets the same answer as bad credentials, never "already registered".
    if (!id) return reply.code(400).send(INVALID);
    // No tokens yet: the account signs in once the emailed code is entered (/auth/verify).
    await sendCode(req, id, normEmail(req.body.email), 'verify');
    return reply.code(201).send({ verify: true });
  });

  app.post<{ Body: { email: string; code: string } }>('/auth/verify', { ...limited, schema: { body: verifyBody } }, async (req, reply) => {
    const userId = await repo.useCode(normEmail(req.body.email), 'verify', sha256(req.body.code));
    if (!userId) return reply.code(400).send({ error: 'invalid_code' });
    await repo.verifyEmail(userId);
    return issue(repo, cfg, userId);
  });

  // A new verify code. Always 202, so the answer never reveals an account or whether it is verified.
  app.post<{ Body: { email: string } }>('/auth/verify/resend', { ...limited, schema: { body: emailBody } }, async (req, reply) => {
    const email = normEmail(req.body.email), u = await repo.userByEmail(email);
    if (u && !u.verified) await sendCode(req, u.id, email, 'verify');
    return reply.code(202).send();
  });

  app.post<{ Body: Creds }>('/auth/login', { ...limited, schema: { body: credentials } }, async (req, reply) => {
    const u = await repo.userByEmail(normEmail(req.body.email));
    const ok = await verify(u?.passwordHash ?? DUMMY, req.body.password);
    if (!u || !ok) return reply.code(401).send(INVALID);
    // Only someone with the right password learns this; the app then asks for the emailed code.
    if (!u.verified) return reply.code(403).send({ error: 'email_unverified' });
    return issue(repo, cfg, u.id);
  });

  app.post<{ Body: { refreshToken: string } }>('/auth/refresh', { ...limited, schema: { body: refreshBody } }, async (req, reply) => {
    const p = pair(cfg);
    if (!(await repo.rotateSession(sha256(req.body.refreshToken), p.row))) return reply.code(401).send({ error: 'session_ended' });
    return p.tokens;
  });

  app.post('/auth/logout', async (req, reply) => {
    const t = bearer(req);
    if (t) await repo.endSessionOf(sha256(t));
    return reply.code(204).send();
  });

  // Always 202, sent or not, and the email goes out after the reply, so neither the answer nor its timing reveals an account.
  app.post<{ Body: { email: string } }>('/auth/forgot', { ...limited, schema: { body: emailBody } }, async (req, reply) => {
    const email = normEmail(req.body.email), u = await repo.userByEmail(email);
    if (u) await sendCode(req, u.id, email, 'reset');
    return reply.code(202).send();
  });

  // The code works once, for RESET_CODE_MINUTES, and 5 wrong tries end it. A new password signs out every device.
  app.post<{ Body: { email: string; code: string; password: string } }>('/auth/reset', { ...limited, schema: { body: resetBody } }, async (req, reply) => {
    const userId = await repo.useCode(normEmail(req.body.email), 'reset', sha256(req.body.code));
    if (!userId) return reply.code(400).send({ error: 'invalid_code' });
    await repo.resetPassword(userId, await hash(req.body.password));
    return issue(repo, cfg, userId);
  });

  // The account: when it is due to be deleted (null when it isn't). The app shows Keep my account while it is.
  app.get('/account', async (req, reply) => {
    const userId = await userOf(repo, req);
    if (!userId) return reply.code(401).send({ error: 'signed_out' });
    return { deleteAt: (await repo.deleteAt(userId))?.toISOString() ?? null };
  });

  // Schedules deletion DELETE_DAYS from now, after the password is entered again. Nothing is removed until then.
  app.delete<{ Body: { password: string } }>('/account', { ...limited, schema: { body: deleteBody } }, async (req, reply) => {
    const userId = await userOf(repo, req);
    if (!userId) return reply.code(401).send({ error: 'signed_out' });
    const h = await repo.passwordHashOf(userId);
    if (!h || !(await verify(h, req.body.password))) return reply.code(401).send(INVALID);
    return { deleteAt: (await repo.scheduleDelete(userId, DELETE_DAYS))!.toISOString() };
  });

  // Keep my account: cancels a scheduled deletion.
  app.post('/account/keep', async (req, reply) => {
    const userId = await userOf(repo, req);
    if (!userId) return reply.code(401).send({ error: 'signed_out' });
    await repo.scheduleDelete(userId, null);
    return reply.code(204).send();
  });
}

// ponytail: plain text only; an HTML template when the owner supplies one. Wording not in the handoff: for owner review.
const CODE_TEXT: Record<CodePurpose, (code: string, minutes: number) => string> = {
  reset: (code, minutes) => `Your What Matters code is ${code}.\n\nIt works for ${minutes} minutes. If you didn't ask for it, you can ignore this email; nothing has changed.`,
  verify: (code, minutes) => `Your What Matters code is ${code}.\n\nEnter it in the app to confirm your email. It works for ${minutes} minutes. If you didn't create an account, you can ignore this email.`,
};
