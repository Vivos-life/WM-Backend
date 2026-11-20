import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The at-rest lock only works if nothing goes around it: SQL lives in src/repo.ts (and the migration runner in src/db.ts).
test('only repo.ts and db.ts talk to the database', () => {
  const dir = path.join(import.meta.dirname, '..', 'src');
  const offenders = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !['repo.ts', 'db.ts'].includes(f))
    .filter((f) =>
      /\.query\s*[<(]|\.connect\s*\(|\b(SELECT|INSERT|UPDATE|DELETE)\b\s/.test(
        fs.readFileSync(path.join(dir, f), 'utf8'),
      ),
    );
  assert.deepEqual(offenders, []);
});
