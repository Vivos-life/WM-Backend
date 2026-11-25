// Make a complaint (the handoff's Privacy sheet): saved with a reference, then emailed to COMPLAINTS_TO. The person sees
// each of theirs with its reference, the date it will be acknowledged by and the replies. The email goes after the reply; if it fails the complaint is still saved.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { userOf } from './auth.ts';
import type { Config } from './config.ts';
import { complaintMail, type Mailer } from './mail.ts';
import type { Repo } from './repo.ts';

/** The handoff's promise: every complaint acknowledged within 30 days. */
export const ACK_DAYS = 30;
const day = (d: Date) => d.toISOString().slice(0, 10);
/** A complaint as the phone shows it. replies: the team's answers, oldest first.
 *  ponytail: always empty until the admin panel writes replies; then only this fills them, the phone already draws them. */
const shown = (ref: string, text: string, at: Date) => ({
  ref,
  text,
  date: day(at),
  ack: day(new Date(at.getTime() + ACK_DAYS * 86_400_000)),
  replies: [] as { date: string; text: string }[],
});

const body = {
  type: 'object',
  required: ['text'],
  additionalProperties: false,
  properties: { text: { type: 'string', minLength: 1, maxLength: 5000, pattern: '\\S' } },
} as const;

export const complaintRoutes = (repo: Repo, cfg: Config, mail: Mailer) => async (app: FastifyInstance) => {
  // The person's own complaints, newest first, with any replies.
  app.get('/complaints', async (req, reply) => {
    const userId = await userOf(repo, req);
    if (!userId) return reply.code(401).send({ error: 'signed_out' });
    return { complaints: (await repo.complaintsOf(userId)).map((c) => shown(c.ref, c.body, c.at)) };
  });

  app.post<{ Body: { text: string } }>(
    '/complaints',
    { schema: { body }, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const userId = await userOf(repo, req);
      if (!userId) return reply.code(401).send({ error: 'signed_out' });
      // ponytail: 4 random bytes; a clash fails the unique ref (a 500, retry), far too rare to loop for.
      const ref = 'WM-' + randomBytes(4).toString('hex').toUpperCase(),
        text = req.body.text.trim();
      const c = shown(ref, text, await repo.addComplaint(userId, ref, text));
      const email = (await repo.emailOf(userId)) ?? '';
      mail({ to: cfg.complaintsTo, ...complaintMail(ref, email, c.date, c.ack, text) }).catch((e: Error) =>
        req.log.error({ err: e.message, ref }, 'complaint email failed'),
      );
      return reply.code(201).send(c);
    },
  );
};
