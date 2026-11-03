// Throwaway capture service for AGE-15 (P0-3).
// Answers 200 to every request and writes its method, path, headers and raw
// body to /data/webhooks/. Not the bridge: no verification, no de-duplication.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? '/data';
const WEBHOOK_DIR = join(DATA_DIR, 'webhooks');
// OAuth captures hold the authorization code and token; they stay out of fixtures.
const OAUTH_DIR = join(DATA_DIR, 'oauth');
const TOKEN_FILE = join(OAUTH_DIR, 'token.json');
// Post a "thought" when a session is created or prompted, so Linear keeps the
// session active and offers the stop control. Set EMIT_THOUGHT=0 to stay silent.
const EMIT_THOUGHT = process.env.EMIT_THOUGHT !== '0';
// AGE-16 points this at a client_credentials token to see whether it can post.
const THOUGHT_TOKEN_FILE = process.env.THOUGHT_TOKEN_FILE ?? TOKEN_FILE;

mkdirSync(WEBHOOK_DIR, { recursive: true });
mkdirSync(OAUTH_DIR, { recursive: true });

let seq = 0;

function slug(s) {
  return String(s).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root';
}

// Best-effort label for the file name only; the stored body is never re-serialised.
function label(raw) {
  try {
    const j = JSON.parse(raw.toString('utf8'));
    return [j.type, j.action, j.agentActivity?.signal].filter(Boolean).map(slug).join('.');
  } catch {
    return '';
  }
}

function capture(dir, req, url, raw) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const name = [ts, String(++seq).padStart(4, '0'), req.method, slug(url.pathname), label(raw)]
    .filter(Boolean)
    .join('_');
  const record = {
    receivedAt: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    rawHeaders: req.rawHeaders,
    bodySha256: createHash('sha256').update(raw).digest('hex'),
    bodyEncoding: 'utf8',
    // Exact bytes as received, as a string. Linear-Signature is an HMAC over these.
    body: raw.toString('utf8'),
  };
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

async function exchangeCode(code, redirectUri) {
  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: process.env.LINEAR_CLIENT_ID,
      client_secret: process.env.LINEAR_CLIENT_SECRET,
    }),
  });
  const text = await res.text();
  writeFileSync(
    join(OAUTH_DIR, `token-exchange-${Date.now()}.json`),
    JSON.stringify({ status: res.status, body: text }, null, 2),
  );
  if (res.ok) writeFileSync(TOKEN_FILE, text);
  return { status: res.status, ok: res.ok };
}

async function emitThought(sessionId, body) {
  if (!existsSync(THOUGHT_TOKEN_FILE)) {
    console.log(`no token yet; not posting a thought to session ${sessionId}`);
    return;
  }
  const { access_token } = JSON.parse(readFileSync(THOUGHT_TOKEN_FILE, 'utf8'));
  const post = () =>
    fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
      body: JSON.stringify({
        query: `mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }`,
        variables: { input: { agentSessionId: sessionId, content: { type: 'thought', body } } },
      }),
    });
  // One retry: a dropped connection here leaves the session marked unresponsive.
  const res = await post().catch((err) => {
    console.log(`thought -> ${sessionId}: ${err.cause?.code ?? err.message}, retrying`);
    return post();
  });
  console.log(`thought -> ${sessionId}: ${res.status} ${await res.text()}`);
}

async function afterWebhook(raw) {
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return;
  }
  if (event.type !== 'AgentSessionEvent' || !EMIT_THOUGHT) return;
  const sessionId = event.agentSession?.id;
  if (!sessionId || event.agentActivity?.signal === 'stop') return;
  await emitThought(sessionId, `Capture service received \`${event.action}\`. Nothing else will happen.`);
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/oauth/callback') {
      const file = capture(OAUTH_DIR, req, url, raw);
      console.log(`${req.method} ${url.pathname} -> ${file}`);
      const code = url.searchParams.get('code');
      let note = 'No code in the callback.';
      if (code) {
        const redirectUri = process.env.PUBLIC_URL
          ? `${process.env.PUBLIC_URL}/oauth/callback`
          : `https://${req.headers.host}/oauth/callback`;
        try {
          const r = await exchangeCode(code, redirectUri);
          note = `Token exchange returned HTTP ${r.status}${r.ok ? ' (token saved)' : ''}.`;
        } catch (err) {
          note = `Token exchange failed: ${err.message}`;
        }
      }
      console.log(note);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`Captured. ${note}\n`);
      return;
    }

    const file = capture(WEBHOOK_DIR, req, url, raw);
    console.log(`${req.method} ${url.pathname} -> ${file}`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok\n');
    afterWebhook(raw).catch((err) => console.error('afterWebhook:', err));
  });
});

server.listen(PORT, () => console.log(`capture service on :${PORT}, writing to ${DATA_DIR}`));
