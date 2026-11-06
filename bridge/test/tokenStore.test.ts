import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildContainer } from "../src/container.js";
import { LinearOAuth } from "../src/linearOAuth.js";
import { NotInstalledError, TokenStore } from "../src/tokenStore.js";
import { CLOCK, FETCH } from "../src/tokens.js";
import { APP_USER_ID, ORGANIZATION_ID, fakeLinear, type FakeLinear } from "./fakeLinear.js";
import { captureLogs } from "./logs.js";
import { testConfig } from "./testConfig.js";

const START = Date.parse("2026-11-04T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// Each test runs against a TokenStore built both ways: by hand, as a unit, and by
// the app's container, which must keep its refresh and revoke guards working.
type Build = "constructed directly" | "built by the container";

let build: Build;
let linear: FakeLinear;
let dataDir: string;
let file: string;
let clock: number;
let logLines: string[];

function store(): TokenStore {
  // Every store in a test logs to the one logLines.
  const { logger } = captureLogs(logLines);
  if (build === "built by the container") {
    const c = buildContainer(testConfig(dataDir), logger);
    c.registerInstance(FETCH, linear.fetch);
    c.registerInstance(CLOCK, () => clock);
    return c.resolve(TokenStore);
  }
  const oauth = new LinearOAuth({
    clientId: "client-id",
    clientSecret: "secret-client-secret",
    redirectUri: "https://coder.example.com/oauth/callback",
    fetch: linear.fetch,
  });
  return new TokenStore({ file, oauth, logger, now: () => clock });
}

function stored(): Record<string, string> {
  return JSON.parse(readFileSync(file, "utf8"));
}

// What the OAuth callback does after an install.
async function install(tokens: TokenStore): Promise<void> {
  const oauth = new LinearOAuth({
    clientId: "client-id",
    clientSecret: "secret-client-secret",
    redirectUri: "https://coder.example.com/oauth/callback",
    fetch: linear.fetch,
  });
  const response = await oauth.exchangeCode("secret-code");
  await tokens.save(response, await oauth.appUser(response.access_token));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "tokens-"));
  tempDirs.push(dataDir);
  file = join(dataDir, "linear", "tokens.json");
  linear = fakeLinear();
  clock = START;
  logLines = [];
});

describe.each<Build>(["constructed directly", "built by the container"])("TokenStore %s", (how) => {
  beforeEach(() => {
    build = how;
  });

  test("is not installed without a file", async () => {
    const tokens = store();
    expect(await tokens.installation()).toBeUndefined();
    await expect(tokens.accessToken()).rejects.toBeInstanceOf(NotInstalledError);
  });

  test("stores tokens and the app user id, readable and owner-only", async () => {
    await install(store());
    expect(stored()).toEqual({
      accessToken: "secret-access-1",
      refreshToken: "secret-refresh-1",
      expiresAt: "2026-11-05T11:59:59.000Z",
      scope: "app:assignable app:mentionable read write",
      appUserId: APP_USER_ID,
      organizationId: ORGANIZATION_ID,
      updatedAt: "2026-11-04T12:00:00.000Z",
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("survives a restart: a new store reads the same file", async () => {
    await install(store());
    const afterRestart = store();
    expect(await afterRestart.accessToken()).toBe("secret-access-1");
    expect((await afterRestart.installation())?.appUserId).toBe(APP_USER_ID);
    expect(linear.tokenRequests).toHaveLength(1);
  });

  test("uses the stored token until shortly before it expires", async () => {
    const tokens = store();
    await install(tokens);
    clock = START + 23 * HOUR;
    expect(await tokens.accessToken()).toBe("secret-access-1");
    expect(linear.tokenRequests).toHaveLength(1);
  });

  test("refreshes a token near expiry and stores the rotated pair", async () => {
    const tokens = store();
    await install(tokens);
    clock = START + 24 * HOUR - 60_000;
    expect(await tokens.accessToken()).toBe("secret-access-2");

    const refresh = linear.tokenRequests[1]!;
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("secret-refresh-1");
    expect(stored()).toMatchObject({
      accessToken: "secret-access-2",
      refreshToken: "secret-refresh-2",
      expiresAt: new Date(clock + 86399 * 1000).toISOString(),
      appUserId: APP_USER_ID,
    });
  });

  // FR-105's manual check: set the stored expiry to the past, then use the bot.
  test("refreshes after expiresAt is edited to the past by hand", async () => {
    const tokens = store();
    await install(tokens);
    writeFileSync(file, JSON.stringify({ ...stored(), expiresAt: "2026-11-01T00:00:00+01:00" }));
    expect(await tokens.accessToken()).toBe("secret-access-2");
    expect(stored().accessToken).toBe("secret-access-2");
  });

  test("runs one refresh for concurrent callers", async () => {
    const tokens = store();
    await install(tokens);
    clock = START + 25 * HOUR;
    const results = await Promise.all([tokens.accessToken(), tokens.accessToken(), tokens.accessToken()]);
    expect(results).toEqual(["secret-access-2", "secret-access-2", "secret-access-2"]);
    expect(linear.tokenRequests).toHaveLength(2);
  });

  test.each([400, 401])("deletes the tokens when Linear refuses a refresh with %i", async (status) => {
    const tokens = store();
    await install(tokens);
    clock = START + 25 * HOUR;
    linear.failNextToken = { status, error: "invalid_grant" };
    await expect(tokens.accessToken()).rejects.toBeInstanceOf(NotInstalledError);
    expect(existsSync(file)).toBe(false);
  });

  test("keeps the tokens when a refresh fails for another reason", async () => {
    const tokens = store();
    await install(tokens);
    clock = START + 25 * HOUR;
    linear.failNextToken = { status: 503, error: "unavailable" };
    await expect(tokens.accessToken()).rejects.toThrow(/HTTP 503/);
    expect(stored().accessToken).toBe("secret-access-1");
    expect(await tokens.accessToken()).toBe("secret-access-2");
  });

  test("does not write back a refresh that finishes after a revoke", async () => {
    const tokens = store();
    await install(tokens);
    clock = START + 25 * HOUR;
    let release!: () => void;
    linear.tokenGate = new Promise((resolve) => (release = resolve));
    const pending = tokens.accessToken();
    await vi.waitFor(() => expect(linear.tokenRequests).toHaveLength(2));
    await tokens.clear("test revoke");
    release();
    await expect(pending).rejects.toBeInstanceOf(NotInstalledError);
    expect(existsSync(file)).toBe(false);
  });

  test("a refused refresh does not delete a reinstall that landed meanwhile", async () => {
    const tokens = store();
    await install(tokens);
    clock = START + 25 * HOUR;
    let release!: () => void;
    linear.tokenGate = new Promise((resolve) => (release = resolve));
    linear.failNextToken = { status: 400, error: "invalid_grant" };
    const pending = tokens.accessToken();
    await vi.waitFor(() => expect(linear.tokenRequests).toHaveLength(2));
    linear.tokenGate = undefined;
    await install(tokens);
    release();
    expect(await pending).toBe("secret-access-2");
    expect(stored().accessToken).toBe("secret-access-2");
  });

  test("treats an unreadable file as not installed and names only the bad fields", async () => {
    const tokens = store();
    await install(tokens);
    writeFileSync(file, JSON.stringify({ ...stored(), expiresAt: "tomorrow" }));
    await expect(tokens.accessToken()).rejects.toBeInstanceOf(NotInstalledError);
    expect(logLines.join("")).toContain('"fields":["expiresAt"]');
  });

  test("clear() deletes the file", async () => {
    const tokens = store();
    await install(tokens);
    await tokens.clear("test");
    expect(existsSync(file)).toBe(false);
    await tokens.clear("again"); // no file is fine
  });

  test("never logs a token", async () => {
    const tokens = store();
    await install(tokens);
    clock = START + 25 * HOUR;
    await tokens.accessToken();
    linear.failNextToken = { status: 400, error: "invalid_grant" };
    clock = START + 50 * HOUR;
    await tokens.accessToken().catch(() => {});
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("")).not.toMatch(/secret-/);
  });
});
