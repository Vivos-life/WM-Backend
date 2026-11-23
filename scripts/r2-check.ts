// npm run r2:check: puts a tiny photo in the R2 bucket from .env, reads it back, deletes it. Prints only ok or what failed,
// never the keys.
import { r2Config } from '../src/config.ts';
import { r2Store } from '../src/photos.ts';

const r2 = r2Config(),
  store = r2Store(r2),
  key = `check/${Date.now()}.jpg`,
  jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
await store.put(key, jpeg);
const back = await store.get(key);
await store.delete(key);
if (!back?.equals(jpeg)) throw new Error('R2 check: read back something else');
if (await store.get(key)) throw new Error('R2 check: still there after delete');
console.log('R2 ok: put, get and delete work on ' + r2.bucket);
