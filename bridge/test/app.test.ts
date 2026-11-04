import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { LinearOAuth } from "../src/linearOAuth.js";
import { TokenStore } from "../src/tokenStore.js";
import { APP_USER_ID, fakeLinear, type FakeLinear } from "./fakeLinear.js";

const repoRolesDir = fileURLToPath(new URL("../../roles/", import.meta.url));
const fixturesDir = fileURLToPath(new URL("../../test/fixtures/linear/webhooks/", import.meta.url));

// The fixtures are signed with this secret, and scrub.mjs zeroes oauthClientId.
const FIXTURE_WEBHOOK_SECRET = "lin_wh_fixture_secret_not_real";
const CLIENT_ID = "0".repeat(32);

interface Fixture {
  headers: Record<string, string>;
  body: string;
}

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), "utf8"));
}

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

let server: Server;
let base: string;
let linear: FakeLinear;
let tokenFile: string;
let logLines: string[];
let clock: number;

beforeEach(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "data-"));
  tempDirs.push(dataDir);
  const config = loadConfig(
    {
      ROLE: "coder",
      CLAUDE_CODE_OAUTH_TOKEN: "secret-oauth-token",
      LINEAR_CLIENT_ID: CLIENT_ID,
      LINEAR_CLIENT_SECRET: "secret-client-secret",
      LINEAR_WEBHOOK_SECRET: FIXTURE_WEBHOOK_SECRET,
      PUBLIC_URL: "https://coder.example.com",
      DATA_DIR: dataDir,
    },
    repoRolesDir,
  );
  linear = fakeLinear();
  logLines = [];
  clock = Date.parse("2026-11-04T12:00:00.000Z");
  const logger = pino({ level: "trace" }, { write: (line: string) => void logLines.push(line) });
  const oauth = new LinearOAuth({
    clientId: config.linear.clientId,
    clientSecret: config.linear.clientSecret,
    redirectUri: `${config.linear.publicUrl}/oauth/callback`,
    fetch: linear.fetch,
  });
  tokenFile = join(dataDir, "linear", "tokens.json");
  const tokens = new TokenStore({ file: tokenFile, oauth, logger, now: () => clock });
  server = createServer(createApp({ config, oauth, tokens, logger, now: () => clock }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function startInstall(): Promise<URL> {
  const res = await fetch(`${base}/oauth/install`, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

function callback(params: Record<string, string>): Promise<Response> {
  return fetch(`${base}/oauth/callback?${new URLSearchParams(params)}`);
}

async function installed(): Promise<void> {
  const state = (await startInstall()).searchParams.get("state")!;
  expect((await callback({ code: "secret-code", state })).status).toBe(200);
}

function postWebhook(body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${base}/webhooks/linear`, { method: "POST", headers, body });
}

// The SDK checks webhookTimestamp against Date.now(), and the fixtures are from
// 2026-11-03. Move Date (only) to just after the delivery was sent.
function deliveredAfter(f: Fixture, ms: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(JSON.parse(f.body).webhookTimestamp + ms);
}

describe("GET /oauth/install", () => {
  test("redirects to Linear's consent screen as an app actor", async () => {
    const url = await startInstall();
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: "https://coder.example.com/oauth/callback",
      response_type: "code",
      scope: "read,write,app:assignable,app:mentionable",
      actor: "app",
      state: expect.stringMatching(/^[\w-]{43}$/),
    });
  });
});

describe("GET /oauth/callback", () => {
  test("exchanges the code and stores the tokens with the app user id", async () => {
    const state = (await startInstall()).searchParams.get("state")!;
    const res = await callback({ code: "secret-code", state });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toMatch(/coder is installed in Linear/);
    expect(page).not.toMatch(/secret-/);

    const exchange = linear.tokenRequests[0]!;
    expect(Object.fromEntries(exchange)).toEqual({
      grant_type: "authorization_code",
      code: "secret-code",
      redirect_uri: "https://coder.example.com/oauth/callback",
      client_id: CLIENT_ID,
      client_secret: "secret-client-secret",
    });
    const stored = JSON.parse(readFileSync(tokenFile, "utf8"));
    expect(stored).toMatchObject({ accessToken: "secret-access-1", appUserId: APP_USER_ID });
  });

  test("rejects an unknown state without calling Linear", async () => {
    const res = await callback({ code: "secret-code", state: "forged" });
    expect(res.status).toBe(400);
    expect(linear.tokenRequests).toHaveLength(0);
    expect(existsSync(tokenFile)).toBe(false);
  });

  test("accepts each state once", async () => {
    const state = (await startInstall()).searchParams.get("state")!;
    expect((await callback({ code: "secret-code", state })).status).toBe(200);
    expect((await callback({ code: "secret-code", state })).status).toBe(400);
    expect(linear.tokenRequests).toHaveLength(1);
  });

  test("rejects an expired state", async () => {
    const state = (await startInstall()).searchParams.get("state")!;
    clock += 11 * 60 * 1000;
    expect((await callback({ code: "secret-code", state })).status).toBe(400);
    expect(linear.tokenRequests).toHaveLength(0);
  });

  test("reports a declined install", async () => {
    const state = (await startInstall()).searchParams.get("state")!;
    const res = await callback({ error: "access_denied", state });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/access_denied/);
  });

  test("reinstalls into the same workspace", async () => {
    await installed();
    await installed();
    expect(JSON.parse(readFileSync(tokenFile, "utf8")).accessToken).toBe("secret-access-2");
  });

  test("refuses an install from another workspace", async () => {
    await installed();
    linear.organizationId = "another-workspace";
    const state = (await startInstall()).searchParams.get("state")!;
    expect((await callback({ code: "secret-code", state })).status).toBe(409);
    expect(JSON.parse(readFileSync(tokenFile, "utf8")).accessToken).toBe("secret-access-1");
  });

  test("refuses a token that belongs to a person", async () => {
    linear.viewerIsApp = false;
    const state = (await startInstall()).searchParams.get("state")!;
    expect((await callback({ code: "secret-code", state })).status).toBe(500);
    expect(existsSync(tokenFile)).toBe(false);
  });

  test("fails without leaking the code when Linear rejects it", async () => {
    linear.failNextToken = { status: 400, error: "invalid_grant" };
    const state = (await startInstall()).searchParams.get("state")!;
    const res = await callback({ code: "secret-code", state });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/secret-/);
    const log = logLines.join("");
    expect(log).toMatch(/authorization_code grant returned HTTP 400 \(invalid_grant\)/);
    expect(log).not.toMatch(/secret-/);
  });
});

describe("POST /webhooks/linear", () => {
  afterEach(() => vi.useRealTimers());

  test("an OAuthApp revoked webhook deletes the stored tokens", async () => {
    await installed();
    const revoked = fixture("oauth-app-revoked");
    deliveredAfter(revoked, 500);
    expect((await postWebhook(revoked.body, revoked.headers)).status).toBe(200);
    expect(existsSync(tokenFile)).toBe(false);
  });

  test("a stale delivery is rejected and changes nothing", async () => {
    await installed();
    const revoked = fixture("oauth-app-revoked");
    deliveredAfter(revoked, 61_000);
    expect((await postWebhook(revoked.body, revoked.headers)).status).toBe(401);
    expect(existsSync(tokenFile)).toBe(true);
    expect(logLines.join("")).toMatch(/Invalid webhook timestamp/);
  });

  test("a revoke for another OAuth client changes nothing", async () => {
    await installed();
    const revoked = fixture("oauth-app-revoked");
    const body = revoked.body.replace(CLIENT_ID, "f".repeat(32));
    const signature = createHmac("sha256", FIXTURE_WEBHOOK_SECRET).update(body).digest("hex");
    deliveredAfter(revoked, 500);
    expect((await postWebhook(body, { ...revoked.headers, "linear-signature": signature })).status).toBe(200);
    expect(existsSync(tokenFile)).toBe(true);
  });

  test("a bad signature is rejected and changes nothing", async () => {
    await installed();
    const { headers, body } = fixture("oauth-app-revoked");
    deliveredAfter({ headers, body }, 500);
    const forged = { ...headers, "linear-signature": "0".repeat(64) };
    expect((await postWebhook(body, forged)).status).toBe(401);
    const { "linear-signature": _, ...unsigned } = headers;
    expect((await postWebhook(body, unsigned)).status).toBe(401);
    expect(existsSync(tokenFile)).toBe(true);
  });

  test("a body changed after signing is rejected", async () => {
    await installed();
    const { headers, body } = fixture("oauth-app-revoked");
    deliveredAfter({ headers, body }, 500);
    expect((await postWebhook(body.replace("revoked", "revoked "), headers)).status).toBe(401);
    expect(existsSync(tokenFile)).toBe(true);
  });

  test("other events are acknowledged and leave the tokens alone", async () => {
    await installed();
    const { headers, body } = fixture("agent-session-created-delegation");
    deliveredAfter({ headers, body }, 500);
    expect((await postWebhook(body, headers)).status).toBe(200);
    expect(existsSync(tokenFile)).toBe(true);
  });
});

test("GET /healthz still answers", async () => {
  const res = await fetch(`${base}/healthz`);
  expect(res.status).toBe(200);
});
