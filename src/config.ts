// Every setting the server reads, from the environment (documented in .env.example). Missing or bad values stop the server at start.
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k} (see .env.example)`);
  return v;
};
const int = (k: string, d: number) => {
  const v = Number(process.env[k] ?? d);
  if (!Number.isInteger(v) || v <= 0) throw new Error(`${k} must be a positive whole number`);
  return v;
};

/** People's own photos: a private Cloudflare R2 bucket and a token that can read and write only it. */
export const r2Config = () => ({
  account: need('R2_ACCOUNT_ID'),
  keyId: need('R2_ACCESS_KEY_ID'),
  secret: need('R2_SECRET_ACCESS_KEY'),
  bucket: need('R2_BUCKET'),
  // A bucket made in a jurisdiction (eu, fedramp) has its own address; empty for the default.
  jurisdiction: process.env.R2_JURISDICTION ?? '',
});

export function loadConfig(env: 'app' | 'test' = 'app') {
  return {
    databaseUrl: need(env === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL'),
    host: process.env.HOST ?? '127.0.0.1',
    port: int('PORT', 3100),
    smtp: {
      host: need('SMTP_HOST'),
      port: int('SMTP_PORT', 587),
      user: need('SMTP_USER'),
      pass: need('SMTP_PASS'),
    },
    mailFrom: need('MAIL_FROM'),
    resetMs: int('RESET_CODE_MINUTES', 15) * 60_000,
    accessMs: int('ACCESS_TOKEN_MINUTES', 15) * 60_000,
    refreshMs: int('REFRESH_TOKEN_DAYS', 30) * 86_400_000,
    r2: r2Config(),
  };
}
export type Config = ReturnType<typeof loadConfig>;
