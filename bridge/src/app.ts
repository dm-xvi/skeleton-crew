// The bridge's HTTP routes. server.ts loads config and listens; this module only
// routes, so tests can drive it with a fake Linear.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  LINEAR_WEBHOOK_SIGNATURE_HEADER,
  LinearWebhookClient,
  type LinearWebhookPayload,
  type OAuthAppWebhookPayload,
} from "@linear/sdk/webhooks";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { LinearOAuth } from "./linearOAuth.js";
import type { TokenStore } from "./tokenStore.js";

// Long enough to read Linear's consent screen and approve.
const INSTALL_STATE_TTL_MS = 10 * 60 * 1000;
// Linear's payloads are a few KB; anything this big is not from Linear.
const MAX_BODY_BYTES = 1024 * 1024;

export interface AppDeps {
  config: Config;
  oauth: LinearOAuth;
  tokens: TokenStore;
  logger: Logger;
  now?: () => number;
}

export function createApp({ config, oauth, tokens, logger, now = Date.now }: AppDeps): RequestListener {
  // One-time CSRF states for installs in flight, with their expiry. In memory is
  // enough: an install that spans a restart just starts over.
  const installStates = new Map<string, number>();
  // Checks the HMAC over the raw body and that the signed webhookTimestamp is within
  // 60 s of now (FR-201, FR-202). AGE-20 adds de-duplication and the queue.
  const webhooks = new LinearWebhookClient(config.linear.webhookSecret);

  function install(res: ServerResponse): void {
    const at = now();
    for (const [state, expiresAt] of installStates) {
      if (expiresAt <= at) installStates.delete(state);
    }
    const state = randomBytes(32).toString("base64url");
    installStates.set(state, at + INSTALL_STATE_TTL_MS);
    res.writeHead(302, { location: oauth.authorizeUrl(state) }).end();
  }

  async function callback(url: URL, res: ServerResponse): Promise<void> {
    const state = url.searchParams.get("state");
    const expiresAt = state ? installStates.get(state) : undefined;
    if (state) installStates.delete(state);
    if (expiresAt === undefined || expiresAt <= now()) {
      logger.warn("OAuth callback with an unknown or expired state");
      text(res, 400, "This install link has expired or was already used. Start again at /oauth/install.");
      return;
    }

    const error = url.searchParams.get("error");
    if (error) {
      logger.warn({ error }, "Linear install was not approved");
      text(res, 400, `Linear did not approve the install (${error}). Start again at /oauth/install.`);
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      text(res, 400, "Linear sent no authorization code. Start again at /oauth/install.");
      return;
    }

    const tokenResponse = await oauth.exchangeCode(code);
    const appUser = await oauth.appUser(tokenResponse.access_token);
    // /oauth/install is public. If the OAuth app is ever made public, someone else's
    // workspace must not be able to replace the install.
    const existing = await tokens.installation();
    if (existing && existing.organizationId !== appUser.organizationId) {
      logger.warn({ organizationId: appUser.organizationId }, "refused an install from another workspace");
      text(res, 409, `${config.role.name} is already installed in another Linear workspace. Revoke it there first.`);
      return;
    }
    await tokens.save(tokenResponse, appUser);
    logger.info({ ...appUser, scope: tokenResponse.scope }, "installed in Linear");
    text(res, 200, `${config.role.name} is installed in Linear. You can close this page.`);
  }

  async function webhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (body === undefined) {
      res.writeHead(413).end();
      return;
    }
    const signature = req.headers[LINEAR_WEBHOOK_SIGNATURE_HEADER];
    let payload: LinearWebhookPayload;
    try {
      // Throws on a bad signature or a stale timestamp; never returns false.
      payload = webhooks.parseData(body, typeof signature === "string" ? signature : "");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ delivery: req.headers["linear-delivery"], reason }, "rejected a webhook");
      res.writeHead(401).end();
      return;
    }
    // The SDK types `type` as a plain string, so the union does not narrow on it.
    if (payload.type === "OAuthApp" && payload.action === "revoked") {
      if ((payload as OAuthAppWebhookPayload).oauthClientId === config.linear.clientId) {
        await tokens.clear("Linear sent an OAuthApp revoked webhook");
      } else {
        logger.warn("ignoring an OAuthApp revoked webhook for another client");
      }
    }
    // Agent session events and notifications are acknowledged and dropped until AGE-20.
    res.writeHead(200).end();
  }

  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://bridge");
    const route = `${req.method} ${url.pathname}`;
    let handled: Promise<void> | void;
    switch (route) {
      case "GET /healthz":
        return text(res, 200, "ok");
      case "GET /oauth/install":
        return install(res);
      case "GET /oauth/callback":
        handled = callback(url, res);
        break;
      case "POST /webhooks/linear":
        handled = webhook(req, res);
        break;
      default:
        res.writeHead(404).end();
        return;
    }
    handled.catch((err: unknown) => {
      // Errors from Linear calls carry a status and an error code, never a token.
      logger.error({ err, route }, "request failed");
      if (!res.headersSent) text(res, 500, "Something went wrong. The bridge log has the details.");
      else res.end();
    });
  };
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(`${body}\n`);
}

// The raw bytes, or undefined if the body is over MAX_BODY_BYTES.
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
