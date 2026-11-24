// npm run mail:preview: writes every code email (each mood, verify and reset) to mail-preview/, with index.html showing them
// side by side. Open it in a browser; for real mail apps, send them with npm run mail:check.
import fs from 'node:fs';
import path from 'node:path';
import { codeMail, MOODS } from '../src/mail.ts';

const dir = path.join(import.meta.dirname, '..', 'mail-preview');
fs.mkdirSync(dir, { recursive: true });
const cells: string[] = [];
for (const mood of MOODS)
  for (const purpose of ['verify', 'reset'] as const) {
    const file = `${mood}-${purpose}.html`;
    fs.writeFileSync(path.join(dir, file), codeMail(purpose, '123456', 15, mood).html);
    cells.push(`<figure><figcaption>${mood} ${purpose}</figcaption><iframe src="${file}"></iframe></figure>`);
  }
fs.writeFileSync(
  path.join(dir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Code emails</title><style>body{font:14px sans-serif;margin:16px;display:flex;flex-wrap:wrap;gap:16px}figure{margin:0}iframe{width:380px;height:460px;border:1px solid #ccc}</style>${cells.join('')}`,
);
console.log('Wrote ' + path.join(dir, 'index.html'));
