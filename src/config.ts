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

export function loadConfig(env: 'app' | 'test' = 'app') {
  return {
    databaseUrl: need(env === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL'),
    host: process.env.HOST ?? '127.0.0.1',
    port: int('PORT', 3100),
    smtpUrl: need('SMTP_URL'),
    mailFrom: need('MAIL_FROM'),
    resetMs: int('RESET_CODE_MINUTES', 15) * 60_000,
    accessMs: int('ACCESS_TOKEN_MINUTES', 15) * 60_000,
    refreshMs: int('REFRESH_TOKEN_DAYS', 30) * 86_400_000,
  };
}
export type Config = ReturnType<typeof loadConfig>;
