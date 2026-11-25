import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh } from './helpers.ts';
import { migrate } from '../src/db.ts';
import { createRepo } from '../src/repo.ts';
import fs from 'node:fs';
import path from 'node:path';
import { DELETE_DAYS } from '../src/auth.ts';
import { codeMail, DEFAULT_MOOD, MOODS } from '../src/mail.ts';
import tokens from '../src/design-tokens.json' with { type: 'json' };

// The workspace's handoff, when this repo sits beside it.
const HANDOFF_TOKENS = path.join(import.meta.dirname, '..', '..', 'handoff', 'tokens', 'design-tokens.json');

const env = (s: string) => Buffer.from(s).toString('base64');

test('migrations run once', async () => {
  const t = await fresh();
  try {
    assert.deepEqual(await migrate(t.db), []);
  } finally {
    await t.close();
  }
});

test('register and login; errors never say whether an email has an account', async () => {
  const t = await fresh();
  try {
    const r = await t.call('POST', '/auth/register', { email: 'Alex@Example.com ', password: 'correct horse' });
    assert.equal(r.statusCode, 400, 'trailing space is not a valid email');
    const ok = await t.call('POST', '/auth/register', { email: 'Alex@Example.com', password: 'correct horse' });
    assert.equal(ok.statusCode, 201);
    assert.deepEqual(ok.json(), { verify: true }, 'no tokens until the email is verified');
    await t.call('POST', '/auth/verify', { email: 'alex@example.com', code: await t.codeFor('alex@example.com') });
    assert.deepEqual(
      (await t.db.query('SELECT email FROM users')).rows,
      [{ email: 'alex@example.com' }],
      'stored once, lower-cased',
    );

    const taken = await t.call('POST', '/auth/register', { email: 'alex@example.com', password: 'another one' });
    assert.equal(taken.statusCode, 400, 'same email, other case');
    assert.deepEqual(taken.json(), { error: 'invalid_credentials' }, 'never "already registered"');

    assert.equal(
      (await t.call('POST', '/auth/login', { email: 'ALEX@example.com', password: 'correct horse' })).statusCode,
      200,
    );
    const wrong = await t.call('POST', '/auth/login', { email: 'alex@example.com', password: 'wrong horse!' });
    const nobody = await t.call('POST', '/auth/login', { email: 'sam@example.com', password: 'correct horse' });
    assert.equal(wrong.statusCode, 401);
    assert.deepEqual(wrong.json(), { error: 'invalid_credentials' });
    assert.deepEqual(nobody.json(), wrong.json(), 'same answer for a wrong password and an unknown email');
  } finally {
    await t.close();
  }
});

test('password reset: a code by email, once, then every device is signed out', async () => {
  const t = await fresh();
  try {
    const old = await t.register();
    const unknown = await t.call('POST', '/auth/forgot', { email: 'nobody@example.com' });
    const known = await t.call('POST', '/auth/forgot', { email: 'Alex@example.com' });
    assert.equal(unknown.statusCode, 202);
    assert.equal(known.statusCode, 202, 'same answer either way');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(
      t.sent.map((m) => m.to),
      ['alex@example.com', 'alex@example.com'],
      'only the real account gets mail (after its verify code)',
    );
    const code = (await t.codeFor('alex@example.com'))!;

    const wrongCode = code === '000000' ? '111111' : '000000';
    assert.deepEqual(
      (
        await t.call('POST', '/auth/reset', { email: 'alex@example.com', code: wrongCode, password: 'new horse!' })
      ).json(),
      { error: 'invalid_code' },
    );
    const done = await t.call('POST', '/auth/reset', { email: 'alex@example.com', code, password: 'new horse!' });
    assert.equal(done.statusCode, 200);
    assert.ok(done.json().accessToken);
    assert.equal(
      (await t.call('POST', '/auth/reset', { email: 'alex@example.com', code, password: 'again horse' })).statusCode,
      400,
      'a code works once',
    );
    assert.equal((await t.call('GET', '/blobs', undefined, old.accessToken)).statusCode, 401, 'old sessions end');
    assert.equal(
      (await t.call('POST', '/auth/login', { email: 'alex@example.com', password: 'correct horse' })).statusCode,
      401,
    );
    assert.equal(
      (await t.call('POST', '/auth/login', { email: 'alex@example.com', password: 'new horse!' })).statusCode,
      200,
    );
  } finally {
    await t.close();
  }
});

test('password reset: five wrong codes end the code; an old code expires', async () => {
  const t = await fresh();
  try {
    await t.register();
    await t.call('POST', '/auth/forgot', { email: 'alex@example.com' });
    const code = (await t.codeFor('alex@example.com'))!,
      wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      await t.call('POST', '/auth/reset', { email: 'alex@example.com', code: wrong, password: 'new horse!' });
    assert.equal(
      (await t.call('POST', '/auth/reset', { email: 'alex@example.com', code, password: 'new horse!' })).statusCode,
      400,
      'the right code no longer works',
    );
  } finally {
    await t.close();
  }
  const short = await fresh({ resetMs: 1 });
  try {
    await short.call('POST', '/auth/register', { email: 'alex@example.com', password: 'correct horse' });
    await short.call('POST', '/auth/forgot', { email: 'alex@example.com' });
    await new Promise((r) => setTimeout(r, 20));
    const code = (await short.codeFor('alex@example.com'))!;
    assert.equal(
      (await short.call('POST', '/auth/reset', { email: 'alex@example.com', code, password: 'new horse!' })).statusCode,
      400,
      'expired',
    );
  } finally {
    await short.close();
  }
});

test('email verification: no sign-in until the emailed code is entered', async () => {
  const t = await fresh();
  try {
    await t.call('POST', '/auth/register', { email: 'alex@example.com', password: 'correct horse' });
    const first = (await t.codeFor('alex@example.com'))!;
    const login = () => t.call('POST', '/auth/login', { email: 'alex@example.com', password: 'correct horse' });
    assert.equal((await login()).statusCode, 403);
    assert.deepEqual((await login()).json(), { error: 'email_unverified' });
    assert.equal(
      (await t.call('POST', '/auth/login', { email: 'alex@example.com', password: 'wrong horse!' })).statusCode,
      401,
      'a wrong password learns nothing',
    );

    // A new code replaces the old one; resend answers the same for unknown emails.
    assert.equal((await t.call('POST', '/auth/verify/resend', { email: 'nobody@example.com' })).statusCode, 202);
    assert.equal((await t.call('POST', '/auth/verify/resend', { email: 'alex@example.com' })).statusCode, 202);
    const second = (await t.codeFor('alex@example.com'))!;
    assert.equal(t.sent.length, 2, 'no mail for an unknown email');
    if (first !== second)
      assert.equal(
        (await t.call('POST', '/auth/verify', { email: 'alex@example.com', code: first })).statusCode,
        400,
        'the old code is replaced',
      );

    const ok = await t.call('POST', '/auth/verify', { email: 'alex@example.com', code: second });
    assert.equal(ok.statusCode, 200);
    assert.equal(
      (await t.call('GET', '/blobs', undefined, ok.json().accessToken)).statusCode,
      200,
      'verifying signs in',
    );
    assert.equal(
      (await t.call('POST', '/auth/verify', { email: 'alex@example.com', code: second })).statusCode,
      400,
      'a code works once',
    );
    assert.equal((await login()).statusCode, 200);
    await t.call('POST', '/auth/verify/resend', { email: 'alex@example.com' });
    assert.equal(await t.codeFor('alex@example.com'), second, 'no new code once verified');
  } finally {
    await t.close();
  }
});

test('email verification: a password reset also proves the email', async () => {
  const t = await fresh();
  try {
    await t.call('POST', '/auth/register', { email: 'alex@example.com', password: 'correct horse' });
    await t.call('POST', '/auth/forgot', { email: 'alex@example.com' });
    const code = (await t.codeFor('alex@example.com'))!;
    assert.equal(
      (await t.call('POST', '/auth/reset', { email: 'alex@example.com', code, password: 'new horse!' })).statusCode,
      200,
    );
    assert.equal(
      (await t.call('POST', '/auth/login', { email: 'alex@example.com', password: 'new horse!' })).statusCode,
      200,
    );
  } finally {
    await t.close();
  }
});

test("emails use the account's mood: the default until the phone sends one", async () => {
  const t = await fresh();
  try {
    const last = async () => {
      await new Promise((r) => setImmediate(r));
      return t.sent.at(-1)!;
    };
    const { accessToken } = await t.register();
    const first = t.sent.at(-1)!;
    assert.match(first.html!, new RegExp(tokens.moods[DEFAULT_MOOD]['--surface']));
    assert.equal((await t.call('PUT', '/account/mood', { mood: 'evergreen' })).statusCode, 401);
    assert.equal((await t.call('PUT', '/account/mood', { mood: 'neon' }, accessToken)).statusCode, 400);
    assert.equal((await t.call('PUT', '/account/mood', { mood: 'evergreen' }, accessToken)).statusCode, 204);
    await t.call('POST', '/auth/forgot', { email: 'alex@example.com' });
    const m = await last();
    assert.match(m.html!, new RegExp(tokens.moods.evergreen['--surface']));
    assert.match(m.html!, /color-scheme" content="dark"/);
    const code = /\b(\d{6})\b/.exec(m.text)![1];
    assert.ok(m.html!.includes('>' + code + '<'));
  } finally {
    await t.close();
  }
});

test('code emails: every mood draws, with the same words as the text part and never a dash', () => {
  for (const mood of MOODS)
    for (const purpose of ['verify', 'reset'] as const) {
      const m = codeMail(purpose, '123456', 15, mood);
      const words = m.html.replace(/<style>[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      for (const s of m.text.replace(' 123456.', '').split(/\n+|(?<=\.) /))
        assert.ok(words.includes(s), mood + ' ' + purpose + ': ' + s);
      assert.ok(words.includes(' 123456 '));
      assert.doesNotMatch(m.text + words, /[\u2013\u2014]|--/);
    }
});

test("design tokens are the handoff's, unchanged", { skip: !fs.existsSync(HANDOFF_TOKENS) }, () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(HANDOFF_TOKENS, 'utf8')), tokens);
});

test('account deletion: password again, 30 days to change your mind, then everything goes', async () => {
  const t = await fresh();
  try {
    const a = await t.register(),
      b = await t.register('sam@example.com');
    await t.call('PUT', '/blobs/pf', { version: 0, envelope: env('sealed') }, a.accessToken);
    await t.call('PUT', '/blobs/pf', { version: 0, envelope: env('sam') }, b.accessToken);
    const repo = createRepo(t.db),
      days = async () => {
        const d = (await t.call('GET', '/account', undefined, a.accessToken)).json().deleteAt;
        return d && Math.round((Date.parse(d) - Date.now()) / 86_400_000);
      };
    assert.equal(await days(), null);

    assert.equal((await t.call('DELETE', '/account', { password: 'correct horse' })).statusCode, 401, 'signed in only');
    const wrong = await t.call('DELETE', '/account', { password: 'wrong horse!' }, a.accessToken);
    assert.equal(wrong.statusCode, 401);
    assert.deepEqual(wrong.json(), { error: 'invalid_credentials' });

    const del = await t.call('DELETE', '/account', { password: 'correct horse' }, a.accessToken);
    assert.equal(del.statusCode, 200);
    assert.equal(await days(), DELETE_DAYS);
    assert.equal((await repo.purgeDeleted()).length, 0, 'nothing goes before the date');
    assert.equal(
      (await t.call('GET', '/blobs', undefined, a.accessToken)).json().length,
      1,
      'still there to see and download',
    );
    assert.equal(
      (await t.call('POST', '/auth/login', { email: 'alex@example.com', password: 'correct horse' })).statusCode,
      200,
      'and to sign in to',
    );

    // Keep my account cancels it; asking again starts a fresh 30 days.
    assert.equal((await t.call('POST', '/account/keep', undefined, a.accessToken)).statusCode, 204);
    assert.equal(await days(), null);
    await t.call('DELETE', '/account', { password: 'correct horse' }, a.accessToken);

    // The date comes: the account, its sessions and its records go; other accounts are untouched.
    await t.db.query("UPDATE users SET delete_at = now() - interval '1 second' WHERE email = 'alex@example.com'");
    assert.equal((await repo.purgeDeleted()).length, 1);
    const left = async (sql: string) => (await t.db.query(sql)).rows.map((r) => r.email ?? r.n);
    assert.deepEqual(await left('SELECT email FROM users'), ['sam@example.com']);
    assert.deepEqual(
      await left('SELECT count(*)::int AS n FROM blobs'),
      [1],
      'only the other account’s record is left',
    );
    assert.deepEqual(
      await left('SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id'),
      [1],
      'only the other account’s session is left',
    );
    assert.equal((await t.call('GET', '/blobs', undefined, a.accessToken)).statusCode, 401, 'its sessions end');
    assert.equal((await t.call('POST', '/auth/refresh', { refreshToken: a.refreshToken })).statusCode, 401);
    assert.equal(
      (await t.call('POST', '/auth/login', { email: 'alex@example.com', password: 'correct horse' })).statusCode,
      401,
    );
    assert.equal(
      (await t.call('GET', '/blobs', undefined, b.accessToken)).statusCode,
      200,
      'other accounts are untouched',
    );
  } finally {
    await t.close();
  }
});

test('register rejects short passwords, bad emails and extra fields', async () => {
  const t = await fresh();
  try {
    for (const body of [
      { email: 'a@b.co', password: 'short' },
      { email: 'not-an-email', password: 'long enough' },
      { email: 'a@b.co', password: 'long enough', admin: true },
      { email: 'a@b.co', password: 'x'.repeat(129) },
    ]) {
      assert.equal((await t.call('POST', '/auth/register', body)).statusCode, 400, JSON.stringify(body));
    }
  } finally {
    await t.close();
  }
});

test('blobs: signed-in only, versioned, opaque, and private to their owner', async () => {
  const t = await fresh();
  try {
    const a = (await t.register()).accessToken,
      b = (await t.register('sam@example.com')).accessToken;
    assert.equal((await t.call('GET', '/blobs')).statusCode, 401);
    assert.equal((await t.call('GET', '/blobs', undefined, 'made-up')).statusCode, 401);

    const first = await t.call('PUT', '/blobs/pf', { version: 0, envelope: env('sealed v1') }, a);
    assert.deepEqual(first.json(), { kind: 'pf', version: 1 });
    const stale = await t.call('PUT', '/blobs/pf', { version: 0, envelope: env('other device') }, a);
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(stale.json(), { error: 'version_conflict', current: 1 });
    assert.deepEqual((await t.call('PUT', '/blobs/pf', { version: 1, envelope: env('sealed v2') }, a)).json(), {
      kind: 'pf',
      version: 2,
    });
    assert.equal((await t.call('PUT', '/blobs/pf', { version: 1, envelope: env('late') }, a)).statusCode, 409);

    const mine = (await t.call('GET', '/blobs', undefined, a)).json();
    assert.equal(mine.length, 1);
    assert.equal(Buffer.from(mine[0].envelope, 'base64').toString(), 'sealed v2', 'bytes come back exactly');
    assert.deepEqual((await t.call('GET', '/blobs', undefined, b)).json(), [], 'another user sees nothing');
    assert.deepEqual(
      (await t.call('PUT', '/blobs/pf', { version: 0, envelope: env('sam') }, b)).json(),
      { kind: 'pf', version: 1 },
      'versions are per user',
    );

    assert.equal(
      (await t.call('PUT', '/blobs/secrets', { version: 0, envelope: env('x') }, a)).statusCode,
      400,
      'unknown kind',
    );
    assert.equal(
      (await t.call('PUT', '/blobs/cfg', { version: 0, envelope: 'not base64!' }, a)).statusCode,
      400,
      'not base64',
    );
  } finally {
    await t.close();
  }
});

test('refresh rotates; reusing an old refresh token ends the session', async () => {
  const t = await fresh();
  try {
    const one = await t.register();
    const two = (await t.call('POST', '/auth/refresh', { refreshToken: one.refreshToken })).json();
    assert.ok(two.accessToken && two.accessToken !== one.accessToken);
    assert.equal(
      (await t.call('GET', '/blobs', undefined, one.accessToken)).statusCode,
      401,
      'old access token stops working',
    );
    assert.equal((await t.call('GET', '/blobs', undefined, two.accessToken)).statusCode, 200);

    // Someone replays the first refresh token: refused, and the live session is revoked too.
    assert.equal((await t.call('POST', '/auth/refresh', { refreshToken: one.refreshToken })).statusCode, 401);
    assert.equal((await t.call('GET', '/blobs', undefined, two.accessToken)).statusCode, 401);
    assert.equal((await t.call('POST', '/auth/refresh', { refreshToken: two.refreshToken })).statusCode, 401);
  } finally {
    await t.close();
  }
});

test('logout ends the session; expired access tokens are refused', async () => {
  const t = await fresh();
  try {
    const s = await t.register();
    assert.equal((await t.call('POST', '/auth/logout', undefined, s.accessToken)).statusCode, 204);
    assert.equal((await t.call('GET', '/blobs', undefined, s.accessToken)).statusCode, 401);
    assert.equal((await t.call('POST', '/auth/refresh', { refreshToken: s.refreshToken })).statusCode, 401);
  } finally {
    await t.close();
  }
  const short = await fresh({ accessMs: 1 });
  try {
    const s = await short.register();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await short.call('GET', '/blobs', undefined, s.accessToken)).statusCode, 401);
    assert.equal(
      (await short.call('POST', '/auth/refresh', { refreshToken: s.refreshToken })).statusCode,
      200,
      'refresh still works',
    );
  } finally {
    await short.close();
  }
});

test('signed-in devices: named at sign-in, kept through refresh, one signed out from another', async () => {
  const t = await fresh();
  try {
    const login = async (device?: string) =>
      (await t.call('POST', '/auth/login', { email: 'alex@example.com', password: 'correct horse', device })).json();
    const first = await t.register(); // verify sends no name
    const ipad = await login('iPad Air'),
      phone = await login('iPhone 16 Pro');
    const ipad2 = (await t.call('POST', '/auth/refresh', { refreshToken: ipad.refreshToken })).json();
    const list = (await t.call('GET', '/account/devices', undefined, phone.accessToken)).json().devices;
    assert.deepEqual(
      list.map((d: { name: string; me: boolean }) => [d.name, d.me]),
      [
        ['iPad Air', false],
        ['iPhone 16 Pro', true],
        [null, false],
      ],
      'latest first; the refresh made the iPad latest and kept its name',
    );
    assert.ok(list.every((d: { lastUsed: string }) => !Number.isNaN(Date.parse(d.lastUsed))));

    const someone = (await t.register('sam@example.com')).accessToken;
    assert.equal((await t.call('DELETE', '/account/devices/' + list[0].id, undefined, someone)).statusCode, 404);
    assert.equal((await t.call('DELETE', '/account/devices/nope', undefined, phone.accessToken)).statusCode, 400);
    assert.equal(
      (await t.call('DELETE', '/account/devices/' + list[0].id, undefined, phone.accessToken)).statusCode,
      204,
    );
    assert.equal(
      (await t.call('GET', '/blobs', undefined, ipad2.accessToken)).statusCode,
      401,
      'its access stops at once',
    );
    assert.equal((await t.call('POST', '/auth/refresh', { refreshToken: ipad2.refreshToken })).statusCode, 401);
    assert.equal((await t.call('GET', '/blobs', undefined, first.accessToken)).statusCode, 200, 'the others stay');
    assert.equal((await t.call('GET', '/account/devices', undefined, phone.accessToken)).json().devices.length, 2);
    assert.equal(
      (
        await t.call('POST', '/auth/login', {
          email: 'alex@example.com',
          password: 'correct horse',
          device: 'x'.repeat(65),
        })
      ).statusCode,
      400,
    );
  } finally {
    await t.close();
  }
});

test('complaints: signed in only, saved with a reference, emailed to COMPLAINTS_TO, acknowledged within 30 days', async () => {
  const t = await fresh();
  try {
    const { accessToken } = await t.register();
    assert.equal((await t.call('POST', '/complaints', { text: 'x' })).statusCode, 401);
    assert.equal((await t.call('POST', '/complaints', { text: '   ' }, accessToken)).statusCode, 400);
    assert.equal((await t.call('POST', '/complaints', { text: 'x'.repeat(5001) }, accessToken)).statusCode, 400);
    const r = await t.call('POST', '/complaints', { text: '  You kept my old photo.  ' }, accessToken);
    assert.equal(r.statusCode, 201);
    const { ref, date, ack, text, replies } = r.json();
    assert.equal(text, 'You kept my old photo.');
    assert.deepEqual(replies, []);
    assert.match(ref, /^WM-[0-9A-F]{8}$/);
    assert.equal((Date.parse(ack) - Date.parse(date)) / 86_400_000, 30);
    const saved = await t.db.query('SELECT ref, body FROM complaints');
    assert.deepEqual(saved.rows, [{ ref, body: 'You kept my old photo.' }]);
    await new Promise((res) => setImmediate(res));
    const m = t.sent.findLast((x) => x.to === 'complaints@example.com')!;
    assert.equal(m.subject, 'Complaint ' + ref);
    assert.ok(m.text.includes('alex@example.com') && m.text.includes('You kept my old photo.') && !m.html);

    // Each person sees their own, newest first.
    await t.call('POST', '/complaints', { text: 'Second one.' }, accessToken);
    const mine = (await t.call('GET', '/complaints', undefined, accessToken)).json().complaints;
    assert.deepEqual(
      mine.map((c: { text: string }) => c.text),
      ['Second one.', 'You kept my old photo.'],
    );
    assert.deepEqual(mine[1], { ref, text: 'You kept my old photo.', date, ack, replies: [] });
    const sam = (await t.register('sam@example.com')).accessToken;
    assert.deepEqual((await t.call('GET', '/complaints', undefined, sam)).json().complaints, []);
    assert.equal((await t.call('GET', '/complaints')).statusCode, 401);
  } finally {
    await t.close();
  }
});

test('login is rate limited', async () => {
  const t = await fresh();
  try {
    const codes = [];
    for (let i = 0; i < 11; i++)
      codes.push(
        (await t.call('POST', '/auth/login', { email: 'x@example.com', password: 'guess number ' + i })).statusCode,
      );
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
    assert.equal(codes[10], 429);
  } finally {
    await t.close();
  }
});

test('health', async () => {
  const t = await fresh();
  try {
    assert.deepEqual((await t.call('GET', '/health')).json(), { ok: true });
  } finally {
    await t.close();
  }
});
