// Throwaway probe for AGE-16 (P0-4): mints a client_credentials token and asks
// Linear who a token belongs to.
//
//   node --env-file=credentials/coder/linear.env spikes/AGE-16-install-grants/grants.mjs client-credentials
//   node spikes/AGE-16-install-grants/grants.mjs viewer [tokenFile]
//
// Tokens go to data/oauth/ (git-ignored) and are never printed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OAUTH_DIR = join(process.env.DATA_DIR ?? 'data', 'oauth');
// The authorization_code callback writes token.json, so the client_credentials
// token gets its own file and neither overwrites the other.
const CC_TOKEN_FILE = join(OAUTH_DIR, 'client-credentials-token.json');
const SCOPE = 'read,write,app:assignable,app:mentionable';

const VIEWER_QUERY = `{
  viewer { id name displayName app active }
  organization { id name urlKey }
}`;

async function graphql(accessToken, query) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, body: await res.text() };
}

async function viewer(tokenFile) {
  const { access_token } = JSON.parse(readFileSync(tokenFile, 'utf8'));
  const r = await graphql(access_token, VIEWER_QUERY);
  console.log(`viewer with ${tokenFile}: HTTP ${r.status}\n${r.body}`);
}

async function clientCredentials() {
  const { LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET } = process.env;
  if (!LINEAR_CLIENT_ID || !LINEAR_CLIENT_SECRET) {
    console.error('LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must be set (use --env-file).');
    process.exit(2);
  }
  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: SCOPE,
      client_id: LINEAR_CLIENT_ID,
      client_secret: LINEAR_CLIENT_SECRET,
    }),
  });
  const text = await res.text();
  mkdirSync(OAUTH_DIR, { recursive: true });
  writeFileSync(
    join(OAUTH_DIR, `client-credentials-exchange-${Date.now()}.json`),
    JSON.stringify({ status: res.status, body: text }, null, 2),
  );

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(`client_credentials: HTTP ${res.status}, non-JSON body:\n${text}`);
    return;
  }
  if (!res.ok) {
    console.log(`client_credentials: HTTP ${res.status}\n${text}`);
    return;
  }
  writeFileSync(CC_TOKEN_FILE, text);
  // Everything but the token itself is safe to show.
  const { access_token, refresh_token, ...rest } = json;
  console.log(`client_credentials: HTTP ${res.status}`, { ...rest, refresh_token: refresh_token ? '<present>' : '<absent>' });
  await viewer(CC_TOKEN_FILE);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'client-credentials') await clientCredentials();
else if (cmd === 'viewer') await viewer(arg ?? join(OAUTH_DIR, 'token.json'));
else {
  console.error('usage: grants.mjs client-credentials | viewer [tokenFile]');
  process.exit(2);
}
