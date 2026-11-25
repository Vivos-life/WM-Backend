// Outgoing email. The app takes a Mailer, so tests capture messages and production sends through SMTP (Mailtrap locally, Resend or similar live).
import nodemailer from 'nodemailer';
import type { Config } from './config.ts';
import type { CodePurpose } from './repo.ts';
import tokens from './design-tokens.json' with { type: 'json' };

export type Mail = { to: string; subject: string; text: string; html?: string };
export type Mailer = (m: Mail) => Promise<void>;

export function smtpMailer(cfg: Config): Mailer {
  const { host, port, user, pass } = cfg.smtp;
  // Port 465 speaks TLS from the start; 587 and 2525 upgrade to it (STARTTLS), and requireTLS refuses to send without it.
  const t = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass },
  });
  return async (m) => {
    await t.sendMail({ from: cfg.mailFrom, ...m });
  };
}

/** The handoff's nine colour moods (design-tokens.json, copied unchanged). Emails use the person's, or the default. */
export type Mood = keyof typeof tokens.moods;
export const MOODS = Object.keys(tokens.moods) as Mood[];
/** The prototype's default mood, as the app's. */
export const DEFAULT_MOOD: Mood = 'mauve';
const moodOf = (m: string | null | undefined): Mood => (m && m in tokens.moods ? (m as Mood) : DEFAULT_MOOD);

// Wording not in the handoff: for owner review. One copy for both the text and the HTML part.
const CODE_COPY: Record<CodePurpose, (minutes: number) => { body: string; note: string }> = {
  reset: (minutes) => ({
    body: `It works for ${minutes} minutes.`,
    note: "If you didn't ask for it, you can ignore this email; nothing has changed.",
  }),
  verify: (minutes) => ({
    body: `Enter it in the app to confirm your email. It works for ${minutes} minutes.`,
    note: "If you didn't create an account, you can ignore this email.",
  }),
};

/** A dark mood (light words on a dark page), so mail apps that recolour for dark mode know the email already is. */
const isDark = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
};

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The emailed 6-digit code, as plain text and as HTML in the mood's colours. The HTML keeps to what mail apps draw
 *  reliably: tables, inline styles, a solid colour under the hero gradient (Outlook draws no gradients) and system fonts
 *  behind Manrope and DM Sans (most apps load no web fonts). The code and minutes are the only values in it, both digits. */
export function codeMail(purpose: CodePurpose, code: string, minutes: number, mood?: string | null) {
  const { body, note } = CODE_COPY[purpose](minutes);
  const lead = 'Your What Matters code is';
  const c = Object.fromEntries(Object.entries(tokens.moods[moodOf(mood)]).map(([k, v]) => [k.slice(2), v])) as Record<
    string,
    string
  >;
  const scheme = isDark(c.bg) ? 'dark' : 'light';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${scheme}">
<meta name="supported-color-schemes" content="${scheme}">
<title>Your What Matters code</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&amp;family=Manrope:wght@800&amp;display=swap" rel="stylesheet">
<style>:root{color-scheme:${scheme};supported-color-schemes:${scheme}}body{margin:0;padding:0}@media (max-width:520px){.wm-pad{padding:28px 22px!important}.wm-code{font-size:32px!important;letter-spacing:6px!important}}</style>
</head>
<body style="margin:0;padding:0;background:${c.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.bg}" style="background:${c.bg};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;border-collapse:separate;">
<tr><td bgcolor="${c.hA}" style="background-color:${c.hA};background-image:linear-gradient(160deg,${c.hA} 0%,${c.hB} 55%,${c.hC} 100%);border-radius:28px 28px 0 0;padding:26px 32px;">
<span style="font-family:Manrope,${SANS};font-weight:800;font-size:21px;letter-spacing:-1px;color:${c.hink};">What Matters</span>
</td></tr>
<tr><td class="wm-pad" bgcolor="${c.surface}" style="background:${c.surface};border:1px solid ${c.line};border-top:0;border-radius:0 0 28px 28px;padding:32px;font-family:'DM Sans',${SANS};font-size:16px;line-height:1.5;color:${c.ink};">
<p style="margin:0 0 14px;color:${c.ink};">${lead}</p>
<div class="wm-code" style="background:${c.wash};border-radius:18px;padding:20px 12px;text-align:center;font-family:Manrope,${SANS};font-weight:800;font-size:38px;line-height:1.1;letter-spacing:8px;color:${c.ink};">${code}</div>
<p style="margin:24px 0 0;color:${c.ink};">${body}</p>
<p style="margin:14px 0 0;font-size:14px;color:${c.muted};">${note}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { subject: 'Your What Matters code', text: `${lead} ${code}.\n\n${body} ${note}`, html };
}

/** A complaint, to the team's inbox (COMPLAINTS_TO): plain text, so nothing the person typed is ever drawn as HTML. */
export function complaintMail(ref: string, from: string, received: string, ackBy: string, text: string) {
  return {
    subject: `Complaint ${ref}`,
    text: `Reference: ${ref}\nAccount: ${from}\nReceived: ${received}\nAcknowledge by: ${ackBy}\n\n${text}`,
  };
}
