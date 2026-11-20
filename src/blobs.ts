// The household's records, stored sealed. The server checks only who owns a blob and its version; it never opens the envelope.
// Today the phone seals with no encryption; when the encryption strategy is decided, only the phone's sealing changes, not this file.
import type { FastifyInstance } from 'fastify';
import { userOf } from './auth.ts';
import type { Repo } from './repo.ts';

export const KINDS = ['cfg', 'pf', 'plan'] as const;
// ponytail: 1 MB per record is far above a household's size; raise it if attachments ever go in a blob.
const MAX_ENVELOPE = 1_000_000;

const putBody = {
  type: 'object',
  required: ['version', 'envelope'],
  additionalProperties: false,
  properties: {
    // The version this save replaces: 0 for the first save. A mismatch means another device saved first.
    version: { type: 'integer', minimum: 0 },
    envelope: { type: 'string', maxLength: Math.ceil(MAX_ENVELOPE / 3) * 4, pattern: '^[A-Za-z0-9+/]*={0,2}$' },
  },
} as const;

/** Registered as its own plugin, so the signed-in check covers these routes only. */
export const blobRoutes = (repo: Repo) => async (app: FastifyInstance) => {
  app.addHook('preHandler', async (req, reply) => {
    const user = await userOf(repo, req);
    if (!user) return reply.code(401).send({ error: 'signed_out' });
    req.user = user;
  });

  app.get('/blobs', async (req) =>
    (await repo.blobs(req.user)).map((b) => ({
      kind: b.kind,
      version: b.version,
      envelope: b.envelope.toString('base64'),
      updatedAt: b.updatedAt.toISOString(),
    })),
  );

  app.put<{ Params: { kind: string }; Body: { version: number; envelope: string } }>(
    '/blobs/:kind',
    { schema: { params: { type: 'object', properties: { kind: { enum: KINDS } } }, body: putBody } },
    async (req, reply) => {
      const env = Buffer.from(req.body.envelope, 'base64');
      if (env.length > MAX_ENVELOPE) return reply.code(413).send({ error: 'too_large' });
      // Saves only over exactly the version the phone last saw. Anything else is a conflict.
      const r = await repo.putBlob(req.user, req.params.kind, req.body.version, env);
      if ('conflict' in r) return reply.code(409).send({ error: 'version_conflict', current: r.conflict });
      return { kind: req.params.kind, version: r.version };
    },
  );
};

declare module 'fastify' {
  interface FastifyRequest {
    user: string;
  }
}
