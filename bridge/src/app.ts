// The bridge's HTTP routes. The container builds the controllers; this module only
// maps URLs to them, so tests can drive it with a fake Linear.
import express, { type ErrorRequestHandler, type Express } from "express";
import type { DependencyContainer } from "tsyringe";
import { empty, text } from "./http.js";
import { OAuthController } from "./oauthController.js";
import { LOGGER } from "./tokens.js";
import { WebhookController } from "./webhookController.js";

// Linear's payloads are a few KB; anything this big is not from Linear.
const MAX_BODY_BYTES = 1024 * 1024;

export function createApp(c: DependencyContainer): Express {
  // Resolved now, not per request, so a missing registration fails at startup.
  const oauth = c.resolve(OAuthController);
  const webhooks = c.resolve(WebhookController);
  const logger = c.resolve(LOGGER);

  const app = express();
  app.disable("x-powered-by");
  // Match paths exactly, as the bridge always has: no /HEALTHZ, no /healthz/.
  // Set before the first route, which creates the router.
  app.enable("case sensitive routing");
  app.enable("strict routing");
  // Express answers HEAD from a GET route, which here would mint an install state or
  // run the code exchange. Only the methods each route names are served.
  app.use((req, res, next) => (req.method === "HEAD" ? empty(res, 404) : next()));

  app.get("/healthz", (_req, res) => text(res, 200, "ok"));
  app.get("/oauth/install", oauth.install);
  app.get("/oauth/callback", oauth.callback);
  // Raw bytes on this route only: the signature covers the body exactly as sent.
  // Any content type is read, and nothing is decompressed.
  app.post(
    "/webhooks/linear",
    express.raw({ type: () => true, limit: MAX_BODY_BYTES, inflate: false }),
    webhooks.receive,
    webhooks.unreadableBody,
  );
  // Express's own 404 is an HTML page; the bridge's is empty.
  app.use((_req, res) => empty(res, 404));

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    // Errors from Linear calls carry a status and an error code, never a token.
    logger.error({ err, route: `${req.method} ${req.path}` }, "request failed");
    if (!res.headersSent) text(res, 500, "Something went wrong. The bridge log has the details.");
    else res.end();
  };
  app.use(onError);
  return app;
}
