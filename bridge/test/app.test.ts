import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DependencyContainer } from "tsyringe";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { buildContainer } from "../src/container.js";
import { NotInstalledError, TokenStore } from "../src/tokenStore.js";
import { CLOCK, FETCH, WEBHOOK_HANDLER } from "../src/tokens.js";
import { LinearEvents } from "../src/linearEvents.js";
import { WebhookQueue, type WebhookEvent } from "../src/webhookQueue.js";
import { APP_USER_ID, fakeLinear, type FakeLinear } from "./fakeLinear.js";
import { captureLogs } from "./logs.js";
import { testConfig } from "./testConfig.js";

const fixturesDir = fileURLToPath(new URL("../../test/fixtures/linear/webhooks/", import.meta.url));

// The fixtures are signed with this secret, and scrub.mjs zeroes oauthClientId.
const FIXTURE_WEBHOOK_SECRET = "lin_wh_fixture_secret_not_real";
const CLIENT_ID = "0".repeat(32);

interface Fixture {
  headers: Record<string, string>;
  body: string;
}

const fixtureNames = readdirSync(fixturesDir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length));

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), "utf8"));
}

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

let c: DependencyContainer;
let server: Server;
let base: string;
let linear: FakeLinear;
let tokenFile: string;
let logLines: string[];
let clock: number;
// Every event the queue handed on, in order.
let handled: WebhookEvent[];
// Runs before the real handler for each event, so a test can make handling slow or fail.
let beforeHandle: () => Promise<void>;

beforeEach(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "data-"));
  tempDirs.push(dataDir);
  const config = testConfig(dataDir, {
    LINEAR_CLIENT_ID: CLIENT_ID,
    LINEAR_WEBHOOK_SECRET: FIXTURE_WEBHOOK_SECRET,
  });
  linear = fakeLinear();
  clock = Date.parse("2026-11-04T12:00:00.000Z");
  const { logger, lines } = captureLogs();
  logLines = lines;
  tokenFile = join(dataDir, "linear", "tokens.json");
  // A fresh container per test, with only Linear and the clock swapped.
  c = buildContainer(config, logger);
  c.registerInstance(FETCH, linear.fetch);
  c.registerInstance(CLOCK, () => clock);
  handled = [];
  beforeHandle = async () => {};
  c.registerInstance(WEBHOOK_HANDLER, {
    handle: async (event) => {
      handled.push(event);
      await beforeHandle();
      await c.resolve(LinearEvents).handle(event);
    },
  });
  server = createServer(createApp(c));
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

// Also waits for the queue to handle what the delivery pushed.
async function postWebhook(body: string, headers: Record<string, string>): Promise<Response> {
  const res = await fetch(`${base}/webhooks/linear`, { method: "POST", headers, body });
  await c.resolve(WebhookQueue).idle();
  return res;
}

// Writes `head` on a bare socket and returns what came back within `ms`, for requests
// fetch cannot send: a body shorter than its Content-Length, or one never finished.
function rawRequest(head: string, ms = 1000): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect((server.address() as AddressInfo).port, "127.0.0.1", () => socket.write(head));
    let reply = "";
    socket.on("data", (data) => (reply += data));
    socket.on("error", () => {});
    const done = (): void => {
      socket.destroy();
      resolve(reply);
    };
    socket.on("close", done);
    setTimeout(done, ms);
  });
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

  // The webhook clears the controller's TokenStore. Only if that is the app's one
  // TokenStore does the revoke stop a refresh another consumer has in flight.
  test("a revoke stops a refresh in flight elsewhere in the app from writing back", async () => {
    await installed();
    clock += 25 * 60 * 60 * 1000;
    let release!: () => void;
    linear.tokenGate = new Promise((resolve) => (release = resolve));
    const pending = c.resolve(TokenStore).accessToken();
    await vi.waitFor(() => expect(linear.tokenRequests).toHaveLength(2));
    const revoked = fixture("oauth-app-revoked");
    deliveredAfter(revoked, 500);
    expect((await postWebhook(revoked.body, revoked.headers)).status).toBe(200);
    release();
    await expect(pending).rejects.toBeInstanceOf(NotInstalledError);
    expect(existsSync(tokenFile)).toBe(false);
  });

  test("a signed body verifies whatever its content type", async () => {
    await installed();
    const revoked = fixture("oauth-app-revoked");
    deliveredAfter(revoked, 500);
    for (const contentType of ["application/json", "text/plain", "application/octet-stream"]) {
      // A new delivery id each time, or the second and third are duplicates.
      const headers = { ...revoked.headers, "content-type": contentType, "linear-delivery": contentType };
      expect((await postWebhook(revoked.body, headers)).status).toBe(200);
    }
    expect(handled).toHaveLength(3);
    expect(existsSync(tokenFile)).toBe(false);
  });

  test("a body over 1 MB gets an empty 413", async () => {
    const res = await fetch(`${base}/webhooks/linear`, { method: "POST", body: Buffer.alloc(1024 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.text()).toBe("");
  });

  test("a body of exactly 1 MB is read and checked", async () => {
    const res = await fetch(`${base}/webhooks/linear`, { method: "POST", body: Buffer.alloc(1024 * 1024) });
    expect(res.status).toBe(401);
  });

  test("a declared length over 1 MB gets its 413 before the body arrives", async () => {
    const reply = await rawRequest(
      "POST /webhooks/linear HTTP/1.1\r\nHost: bridge\r\nContent-Length: 5000000\r\n\r\nabc",
    );
    expect(reply).toMatch(/^HTTP\/1\.1 413 /);
    expect(reply).toMatch(/\r\nconnection: close\r\n/i);
  });

  test("a chunked body is cut off once it passes 1 MB, not read to the end", async () => {
    const { status, sent } = await new Promise<{ status: number | "reset"; sent: number }>((resolve) => {
      let sent = 0;
      const req = request(`${base}/webhooks/linear`, { method: "POST" }, (res) =>
        resolve({ status: res.statusCode!, sent }),
      );
      // The bridge answers 413 and closes the connection mid-upload, so the client's
      // next write can fail before it has read the 413.
      req.on("error", () => resolve({ status: "reset", sent }));
      const chunk = Buffer.alloc(64 * 1024);
      const pump = (): void => {
        while (sent < 64 * 1024 * 1024) {
          sent += chunk.length;
          if (!req.write(chunk)) return void req.once("drain", pump);
        }
        req.end();
      };
      pump();
    });
    expect([413, "reset"]).toContain(status);
    expect(sent).toBeLessThan(16 * 1024 * 1024);
  });

  test("an aborted upload is logged as the client's fault, not a failure", async () => {
    await rawRequest("POST /webhooks/linear HTTP/1.1\r\nHost: bridge\r\nContent-Length: 10\r\n\r\nabc", 50);
    await vi.waitFor(() => expect(logLines.join("")).toMatch(/"level":40,.*"msg":"bad request"/));
    expect(logLines.join("")).not.toMatch(/"msg":"request failed"/);
  });

  test("a compressed body is not decompressed and gets an empty 401", async () => {
    await installed();
    const { headers, body } = fixture("oauth-app-revoked");
    deliveredAfter({ headers, body }, 500);
    const res = await postWebhook(body, { ...headers, "content-encoding": "gzip" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(existsSync(tokenFile)).toBe(true);
  });

  test("a request with no body gets an empty 401", async () => {
    const res = await fetch(`${base}/webhooks/linear`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });
});

// The "answered a webhook" lines, parsed.
function answers(): { delivery?: string; event?: string; status: number; ackMs: number }[] {
  return logLines.map((line) => JSON.parse(line)).filter((entry) => entry.msg === "answered a webhook");
}

describe("replaying the P0-3 fixtures", () => {
  afterEach(() => vi.useRealTimers());

  test.each(fixtureNames)("%s is acknowledged and queued once", async (name) => {
    await installed();
    const f = fixture(name);
    deliveredAfter(f, 400);
    expect((await postWebhook(f.body, f.headers)).status).toBe(200);
    expect(handled).toHaveLength(1);
    const [{ delivery, payload }] = handled as [WebhookEvent];
    expect(delivery).toBe(f.headers["linear-delivery"]);
    expect(payload.type).toBe(f.headers["linear-event"]);
    expect(payload.action).toBe(JSON.parse(f.body).action);
    await vi.waitFor(() =>
      expect(answers()).toContainEqual(
        expect.objectContaining({ delivery: f.headers["linear-delivery"], status: 200 }),
      ),
    );
  });
});

describe("de-duplicating deliveries", () => {
  afterEach(() => vi.useRealTimers());

  test("a repeated delivery is acknowledged, logged as a duplicate and not queued", async () => {
    const f = fixture("agent-session-prompted");
    deliveredAfter(f, 400);
    expect((await postWebhook(f.body, f.headers)).status).toBe(200);
    expect((await postWebhook(f.body, f.headers)).status).toBe(200);
    expect(handled).toHaveLength(1);
    expect(logLines.join("")).toMatch(
      new RegExp(`"delivery":"${f.headers["linear-delivery"]}".*"msg":"ignored a duplicate webhook"`),
    );
  });

  test("two copies arriving together are queued once", async () => {
    const f = fixture("agent-session-prompted");
    deliveredAfter(f, 400);
    const [a, b] = await Promise.all([postWebhook(f.body, f.headers), postWebhook(f.body, f.headers)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(handled).toHaveLength(1);
  });

  // The delivery id isn't signed, so a forgery must not use up a real one.
  test("a rejected request does not mark its delivery id as seen", async () => {
    const f = fixture("agent-session-prompted");
    deliveredAfter(f, 400);
    const forged = { ...f.headers, "linear-signature": "0".repeat(64) };
    expect((await postWebhook(f.body, forged)).status).toBe(401);
    expect((await postWebhook(f.body, f.headers)).status).toBe(200);
    expect(handled).toHaveLength(1);
  });

  test("a delivery id is forgotten after a day", async () => {
    const f = fixture("agent-session-prompted");
    deliveredAfter(f, 400);
    await postWebhook(f.body, f.headers);
    clock += 23 * 60 * 60 * 1000;
    await postWebhook(f.body, f.headers);
    expect(handled).toHaveLength(1);
    clock += 2 * 60 * 60 * 1000;
    await postWebhook(f.body, f.headers);
    expect(handled).toHaveLength(2);
  });

  test("a signed delivery without a Linear-Delivery id is still queued, with a warning", async () => {
    const { "linear-delivery": _, ...headers } = fixture("agent-session-prompted").headers;
    const { body } = fixture("agent-session-prompted");
    deliveredAfter({ headers, body }, 400);
    expect((await postWebhook(body, headers)).status).toBe(200);
    expect(handled).toEqual([expect.objectContaining({ delivery: undefined })]);
    expect(logLines.join("")).toMatch(/"level":40,.*"msg":"a signed webhook has no Linear-Delivery id"/);
  });
});

describe("acknowledging fast", () => {
  afterEach(() => vi.useRealTimers());

  test("the ack is logged and stays under 5 s while handling is stuck", async () => {
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    beforeHandle = () => stuck;
    const first = fixture("agent-session-created-delegation");
    const second = fixture("agent-session-prompted");
    deliveredAfter(first, 400);
    // Plain fetch: postWebhook would wait for the stuck queue.
    const post = (f: Fixture): Promise<Response> =>
      fetch(`${base}/webhooks/linear`, { method: "POST", headers: f.headers, body: f.body });
    expect((await post(first)).status).toBe(200);
    deliveredAfter(second, 400);
    expect((await post(second)).status).toBe(200);
    // The first is stuck in its handler; the second waits its turn.
    expect(handled).toHaveLength(1);
    await vi.waitFor(() => expect(answers()).toHaveLength(2));
    for (const answer of answers()) {
      expect(answer.status).toBe(200);
      expect(answer.ackMs).toBeGreaterThanOrEqual(0);
      expect(answer.ackMs).toBeLessThan(5000);
    }
    release();
    await c.resolve(WebhookQueue).idle();
    expect(handled.map((e) => e.delivery)).toEqual([
      first.headers["linear-delivery"],
      second.headers["linear-delivery"],
    ]);
  });

  test("a rejected delivery's answer is logged too", async () => {
    const f = fixture("agent-session-prompted");
    deliveredAfter(f, 400);
    await postWebhook(f.body, { ...f.headers, "linear-signature": "0".repeat(64) });
    await vi.waitFor(() =>
      expect(answers()).toEqual([
        expect.objectContaining({ delivery: f.headers["linear-delivery"], event: "AgentSessionEvent", status: 401 }),
      ]),
    );
  });

  test("a failed handler is logged and the next event is still handled", async () => {
    beforeHandle = async () => {
      if (handled.length === 1) throw new Error("the first event broke");
    };
    const first = fixture("agent-session-created-delegation");
    const second = fixture("agent-session-prompted");
    deliveredAfter(first, 400);
    expect((await postWebhook(first.body, first.headers)).status).toBe(200);
    deliveredAfter(second, 400);
    expect((await postWebhook(second.body, second.headers)).status).toBe(200);
    expect(handled).toHaveLength(2);
    expect(logLines.join("")).toMatch(/"the first event broke".*"msg":"handling a webhook failed"/);
  });
});

test("GET /healthz still answers", async () => {
  const res = await fetch(`${base}/healthz`);
  expect(res.status).toBe(200);
});

describe("the OAuth install across requests", () => {
  test("an install link from /oauth/install is accepted at /oauth/callback", async () => {
    const first = (await startInstall()).searchParams.get("state")!;
    const second = (await startInstall()).searchParams.get("state")!;
    expect((await callback({ code: "secret-code", state: first })).status).toBe(200);
    expect((await callback({ code: "secret-code", state: second })).status).toBe(200);
  });
});

describe("routing", () => {
  test.each([
    ["GET", "/nope"],
    ["POST", "/healthz"],
    ["GET", "/webhooks/linear"],
    ["GET", "/HEALTHZ"],
    ["GET", "/healthz/"],
    ["HEAD", "/healthz"],
    ["HEAD", "/oauth/install"],
    ["OPTIONS", "/healthz"],
  ])("%s %s gets an empty 404", async (method, path) => {
    const res = await fetch(`${base}${path}`, { method, redirect: "manual" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.text()).toBe("");
  });

  test("an unexpected error gets the plain-text 500", async () => {
    linear.viewerIsApp = false;
    const state = (await startInstall()).searchParams.get("state")!;
    const res = await callback({ code: "secret-code", state });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("Something went wrong. The bridge log has the details.\n");
    expect(logLines.join("")).toMatch(/"route":"GET \/oauth\/callback".*"msg":"request failed"/);
  });

  test("adds no Express headers", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.headers.get("x-powered-by")).toBeNull();
    expect(res.headers.get("etag")).toBeNull();
    expect(await res.text()).toBe("ok\n");
  });
});
