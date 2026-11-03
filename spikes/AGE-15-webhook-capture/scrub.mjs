// Turns raw captures from data/webhooks/ into committed test fixtures.
//
//   node spikes/AGE-15-webhook-capture/scrub.mjs <outDir> <fixtureName>=<captureFile> ...
//
// Personal data is found in the payloads themselves (every object with an
// `email`), so no real value is written into this script. Each scrubbed body is
// re-signed with FIXTURE_WEBHOOK_SECRET, because scrubbing changes the bytes.
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_WEBHOOK_SECRET = 'lin_wh_fixture_secret_not_real';

// Headers Linear sets. Cloudflare and proxy headers (cf-*, x-forwarded-*, cdn-loop) are dropped.
const KEEP_HEADERS = ['content-type', 'user-agent', 'linear-delivery', 'linear-event', 'linear-signature', 'linear-timestamp'];

const [outDir, ...pairs] = process.argv.slice(2);
if (!outDir || pairs.length === 0) {
  console.error('usage: scrub.mjs <outDir> <fixtureName>=<captureFile> ...');
  process.exit(2);
}

const inputs = pairs.map((p) => {
  const [name, file] = p.split('=');
  return { name, file, record: JSON.parse(readFileSync(file, 'utf8')) };
});

// Collect the values to replace across every input, so one person gets one alias everywhere.
const replacements = new Map();
const people = new Map();
function person(email) {
  if (!people.has(email)) people.set(email, people.size + 1);
  return people.get(email);
}
function walk(v) {
  if (Array.isArray(v)) return v.forEach(walk);
  if (!v || typeof v !== 'object') return;
  if (typeof v.email === 'string') {
    const n = person(v.email);
    replacements.set(v.email, `user${n}@example.com`);
    if (typeof v.name === 'string') replacements.set(v.name, `Test User ${n}`);
    if (typeof v.displayName === 'string') replacements.set(v.displayName, `testuser${n}`);
    const slug = typeof v.url === 'string' && v.url.match(/\/profiles\/([^/?#]+)/)?.[1];
    if (slug) replacements.set(`/profiles/${slug}`, `/profiles/test-user-${n}`);
  }
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'string') {
      const org = x.match(/^https:\/\/linear\.app\/([^/]+)\//)?.[1];
      if (org) replacements.set(`linear.app/${org}/`, 'linear.app/example-workspace/');
      if (k === 'oauthClientId') replacements.set(x, '0'.repeat(x.length));
    } else walk(x);
  }
}
for (const { record } of inputs) walk(JSON.parse(record.body));

// Longest first, so a full name is replaced before any shorter value inside it.
const ordered = [...replacements].sort((a, b) => b[0].length - a[0].length);
// Values appear JSON-escaped inside the raw body.
const esc = (s) => JSON.stringify(s).slice(1, -1);

mkdirSync(outDir, { recursive: true });
for (const { name, file, record } of inputs) {
  let body = record.body;
  for (const [from, to] of ordered) body = body.split(esc(from)).join(esc(to));
  JSON.parse(body); // still valid JSON

  for (const [from] of ordered) {
    if (body.includes(esc(from))) throw new Error(`${name}: ${from.length}-char value survived scrubbing`);
  }

  const headers = {};
  for (const h of KEEP_HEADERS) if (h in record.headers) headers[h] = record.headers[h];
  headers['linear-signature'] = createHmac('sha256', FIXTURE_WEBHOOK_SECRET).update(body).digest('hex');

  const out = join(outDir, `${name}.json`);
  writeFileSync(out, JSON.stringify({ capturedAt: record.receivedAt, method: record.method, path: record.path, headers, body }, null, 2) + '\n');
  console.log(`${file} -> ${out}`);
}
console.log(`replaced ${replacements.size} distinct values for ${people.size} people`);
