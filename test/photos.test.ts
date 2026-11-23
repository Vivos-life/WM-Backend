// People's own photos: signed in only, JPEGs only, each account sees only its own, and deleting an account deletes them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh } from './helpers.ts';
import { createRepo } from '../src/repo.ts';
import { MAX_PHOTO, purgeAccounts } from '../src/photos.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const ID = 'a1b2c3d4-photo';

test('a photo goes up, comes back, and goes', async () => {
  const t = await fresh();
  try {
    const a = await t.register(),
      put = (id: string, body: Buffer, token?: string, type = 'image/jpeg') =>
        t.app.inject({
          method: 'PUT',
          url: '/photos/' + id,
          payload: body,
          headers: { 'content-type': type, ...(token ? { authorization: 'Bearer ' + token } : {}) },
        });
    assert.equal((await put(ID, JPEG)).statusCode, 401, 'signed in only');
    assert.equal((await put(ID, Buffer.from('<svg/>'), a.accessToken)).statusCode, 415, 'JPEGs only');
    assert.equal((await put(ID, JPEG, a.accessToken, 'text/plain')).statusCode, 415, 'sent as a JPEG');
    assert.equal((await put('../x', JPEG, a.accessToken)).statusCode, 404, 'no paths in the id');
    assert.equal((await put('short', JPEG, a.accessToken)).statusCode, 400, 'ids are long enough not to guess');
    const big = Buffer.concat([JPEG, Buffer.alloc(MAX_PHOTO)]);
    assert.equal((await put(ID, big, a.accessToken)).statusCode, 413, 'not too big');

    assert.equal((await put(ID, JPEG, a.accessToken)).statusCode, 200);
    const got = await t.call('GET', '/photos/' + ID, undefined, a.accessToken);
    assert.equal(got.statusCode, 200);
    assert.equal(got.headers['content-type'], 'image/jpeg');
    assert.deepEqual(got.rawPayload, JPEG);

    // Another account can't reach it, even with the same id.
    const b = await t.register('sam@example.com');
    assert.equal((await t.call('GET', '/photos/' + ID, undefined, b.accessToken)).statusCode, 404);

    assert.equal((await t.call('DELETE', '/photos/' + ID, undefined, a.accessToken)).statusCode, 200);
    assert.equal((await t.call('GET', '/photos/' + ID, undefined, a.accessToken)).statusCode, 404);
  } finally {
    await t.close();
  }
});

test('a deleted account’s photos go with it, and no one else’s', async () => {
  const t = await fresh();
  try {
    const a = await t.register(),
      b = await t.register('sam@example.com');
    for (const tok of [a.accessToken, b.accessToken])
      await t.app.inject({
        method: 'PUT',
        url: '/photos/' + ID,
        payload: JPEG,
        headers: { 'content-type': 'image/jpeg', authorization: 'Bearer ' + tok },
      });
    assert.equal(t.photos.keys().length, 2);
    await t.call('DELETE', '/account', { password: 'correct horse' }, a.accessToken);
    await t.db.query("UPDATE users SET delete_at = now() - interval '1 second' WHERE email = 'alex@example.com'");
    assert.equal(await purgeAccounts(createRepo(t.db), t.photos), 1);
    const { rows } = await t.db.query("SELECT id FROM users WHERE email = 'sam@example.com'");
    assert.deepEqual(t.photos.keys(), [`u/${rows[0].id}/${ID}.jpg`]);
  } finally {
    await t.close();
  }
});
