// People's own photos (of a person or a moment), kept in a private Cloudflare R2 bucket under the account's id. The phone shrinks
// a photo before it sends it; the household record holds only its id, so another phone signed in to the account fetches it here.
// The app takes a PhotoStore, so tests keep photos in memory and production talks to R2 (S3's API, signed with aws4fetch).
import { AwsClient } from 'aws4fetch';
import type { FastifyInstance } from 'fastify';
import { userOf } from './auth.ts';
import type { Config } from './config.ts';
import type { Repo } from './repo.ts';

export type PhotoStore = {
  put(key: string, body: Buffer): Promise<void>;
  /** null when there's no such photo. */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  /** Every photo whose key starts with prefix: an account's, when it's deleted. */
  deleteAll(prefix: string): Promise<void>;
};

// ponytail: 1 MB is far above a 640 px JPEG; raise it if the phone ever sends larger photos.
export const MAX_PHOTO = 1_000_000;
const ID = '^[A-Za-z0-9-]{8,64}$';
/** Where an account's photo lives. The id comes from the phone; the account's id keeps one account out of another's photos. */
export const photoKey = (userId: string, id: string) => `u/${userId}/${id}.jpg`;
export const userPrefix = (userId: string) => `u/${userId}/`;

export function r2Store(r2: Config['r2']): PhotoStore {
  const aws = new AwsClient({
      accessKeyId: r2.keyId,
      secretAccessKey: r2.secret,
      service: 's3',
      region: 'auto',
    }),
    base = `https://${r2.account}.${r2.jurisdiction ? r2.jurisdiction + '.' : ''}r2.cloudflarestorage.com/${r2.bucket}/`;
  const ok = async (r: Response, what: string) => {
    // R2's own reason (an S3 error code such as AccessDenied or NoSuchBucket) helps tell a wrong key from a wrong bucket.
    if (!r.ok)
      throw new Error(`R2 ${what}: ${r.status} ${/<Code>([^<]+)<\/Code>/.exec(await r.text())?.[1] ?? ''}`.trim());
    return r;
  };
  const del = async (key: string) => {
    const r = await aws.fetch(base + key, { method: 'DELETE' });
    if (r.status !== 404) await ok(r, 'delete');
  };
  return {
    async put(key, body) {
      await ok(
        await aws.fetch(base + key, {
          method: 'PUT',
          body: new Uint8Array(body),
          headers: { 'content-type': 'image/jpeg' },
        }),
        'put',
      );
    },
    async get(key) {
      const r = await aws.fetch(base + key);
      if (r.status === 404) return null;
      return Buffer.from(await (await ok(r, 'get')).arrayBuffer());
    },
    delete: del,
    async deleteAll(prefix) {
      // ponytail: lists up to 1,000 keys and deletes them one by one; an account holds far fewer photos than that.
      const r = await ok(await aws.fetch(`${base}?list-type=2&prefix=${encodeURIComponent(prefix)}`), 'list');
      const keys = [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
      for (const k of keys) await del(k);
    },
  };
}

/** For tests: photos in memory. */
export function memoryStore(): PhotoStore & { keys(): string[] } {
  const m = new Map<string, Buffer>();
  return {
    put: async (k, b) => void m.set(k, b),
    get: async (k) => m.get(k) ?? null,
    delete: async (k) => void m.delete(k),
    deleteAll: async (p) => [...m.keys()].filter((k) => k.startsWith(p)).forEach((k) => m.delete(k)),
    keys: () => [...m.keys()],
  };
}

/** Deletes the accounts whose date has come (repo.purgeDeleted), then their photos. How many accounts went.
 *  ponytail: a failed photo delete throws after the account rows are gone, so the next run won't retry it; log and clear by hand. */
export async function purgeAccounts(repo: Repo, store: PhotoStore): Promise<number> {
  const ids = await repo.purgeDeleted();
  for (const id of ids) await store.deleteAll(userPrefix(id));
  return ids.length;
}

/** Registered as its own plugin, so the signed-in check covers these routes only. */
export const photoRoutes = (repo: Repo, store: PhotoStore) => async (app: FastifyInstance) => {
  // A photo arrives as its own bytes (image/jpeg), not JSON.
  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: MAX_PHOTO }, (_req, body, done) =>
    done(null, body),
  );
  app.addHook('preHandler', async (req, reply) => {
    const user = await userOf(repo, req);
    if (!user) return reply.code(401).send({ error: 'signed_out' });
    req.user = user;
  });
  const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: ID } } } as const;
  type P = { Params: { id: string } };

  app.put<P & { Body: Buffer }>('/photos/:id', { schema: { params } }, async (req, reply) => {
    const b = req.body;
    // Only JPEGs (they start FF D8 FF), so the bucket never holds anything a browser would run.
    if (!Buffer.isBuffer(b) || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff)
      return reply.code(415).send({ error: 'not_a_jpeg' });
    await store.put(photoKey(req.user, req.params.id), b);
    return { id: req.params.id };
  });
  app.get<P>('/photos/:id', { schema: { params } }, async (req, reply) => {
    const b = await store.get(photoKey(req.user, req.params.id));
    if (!b) return reply.code(404).send({ error: 'not_found' });
    return reply.type('image/jpeg').header('cache-control', 'private, max-age=31536000, immutable').send(b);
  });
  app.delete<P>('/photos/:id', { schema: { params } }, async (req) => {
    await store.delete(photoKey(req.user, req.params.id));
    return { id: req.params.id };
  });
};
