import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { container as root, type DependencyContainer } from "tsyringe";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { buildContainer } from "../src/container.js";
import { LinearOAuth } from "../src/linearOAuth.js";
import { OAuthController } from "../src/oauthController.js";
import { NotInstalledError, TokenStore } from "../src/tokenStore.js";
import { CLOCK, FETCH } from "../src/tokens.js";
import { WebhookController } from "../src/webhookController.js";
import { fakeLinear, type FakeLinear } from "./fakeLinear.js";
import { captureLogs } from "./logs.js";
import { testConfig } from "./testConfig.js";

const START = Date.parse("2026-11-04T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

let linear: FakeLinear;
let dataDir: string;
let clock: number;

// What server.ts does, with Linear and the clock swapped before anything resolves.
function app(): DependencyContainer {
  const c = buildContainer(testConfig(dataDir), captureLogs().logger);
  c.registerInstance(FETCH, linear.fetch);
  c.registerInstance(CLOCK, () => clock);
  return c;
}

async function install(c: DependencyContainer): Promise<void> {
  const oauth = c.resolve(LinearOAuth);
  const response = await oauth.exchangeCode("secret-code");
  await c.resolve(TokenStore).save(response, await oauth.appUser(response.access_token));
}

function stored(): Record<string, string> {
  return JSON.parse(readFileSync(join(dataDir, "linear", "tokens.json"), "utf8"));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "container-"));
  tempDirs.push(dataDir);
  linear = fakeLinear();
  clock = START;
});

describe("one app's container", () => {
  test("gives every consumer the same TokenStore and LinearOAuth", () => {
    const c = app();
    expect(c.resolve(TokenStore)).toBe(c.resolve(TokenStore));
    expect(c.resolve(LinearOAuth)).toBe(c.resolve(LinearOAuth));
  });

  // createApp binds each controller's handlers once, so an HTTP test would pass even
  // with a transient controller. Its install states must be one Map for the whole app.
  test("holds one of each controller after createApp", () => {
    const c = app();
    createApp(c);
    expect(c.resolve(OAuthController)).toBe(c.resolve(OAuthController));
    expect(c.resolve(WebhookController)).toBe(c.resolve(WebhookController));
  });

  test("runs one refresh for callers holding separately resolved TokenStores", async () => {
    const c = app();
    await install(c);
    clock = START + 25 * HOUR;
    const [first, second] = [c.resolve(TokenStore), c.resolve(TokenStore)];
    const results = await Promise.all([first.accessToken(), second.accessToken()]);
    expect(results).toEqual(["secret-access-2", "secret-access-2"]);
    expect(linear.tokenRequests).toHaveLength(2);
  });

  test("a revoke through one consumer stops another consumer's refresh from writing back", async () => {
    const c = app();
    await install(c);
    clock = START + 25 * HOUR;
    let release!: () => void;
    linear.tokenGate = new Promise((resolve) => (release = resolve));
    const pending = c.resolve(TokenStore).accessToken();
    await vi.waitFor(() => expect(linear.tokenRequests).toHaveLength(2));
    await c.resolve(TokenStore).clear("test revoke");
    release();
    await expect(pending).rejects.toBeInstanceOf(NotInstalledError);
    expect(existsSync(join(dataDir, "linear", "tokens.json"))).toBe(false);
  });

  test("calls Linear through the registered FETCH and reads time from CLOCK", async () => {
    await install(app());
    expect(linear.tokenRequests).toHaveLength(1);
    expect(stored().updatedAt).toBe("2026-11-04T12:00:00.000Z");
  });
});

describe("two apps' containers", () => {
  test("do not share singletons", () => {
    const [a, b] = [app(), app()];
    expect(a.resolve(TokenStore)).not.toBe(b.resolve(TokenStore));
    expect(a.resolve(LinearOAuth)).not.toBe(b.resolve(LinearOAuth));
    expect(a.resolve(OAuthController)).not.toBe(b.resolve(OAuthController));
    expect(a.resolve(WebhookController)).not.toBe(b.resolve(WebhookController));
  });

  // Two tests in a row, each building its own app, as every test file does.
  let fromEarlierTest: TokenStore | undefined;

  test("a test's app holds its own TokenStore", () => {
    fromEarlierTest = app().resolve(TokenStore);
  });

  test("the next test's app does not see it", () => {
    expect(fromEarlierTest).toBeInstanceOf(TokenStore);
    expect(app().resolve(TokenStore)).not.toBe(fromEarlierTest);
  });
});

describe("startup", () => {
  test("createApp throws when a registration is missing", () => {
    // A child of the global container with nothing registered, as if buildContainer forgot CONFIG.
    expect(() => createApp(root.createChildContainer())).toThrow(/unregistered dependency token: "Symbol\(Config\)"/);
  });

  test("createApp throws when a service cannot be built", () => {
    const c = app();
    c.register(LinearOAuth, {
      useFactory: () => {
        throw new Error("LinearOAuth is misconfigured");
      },
    });
    expect(() => createApp(c)).toThrow(/LinearOAuth is misconfigured/);
  });
});
