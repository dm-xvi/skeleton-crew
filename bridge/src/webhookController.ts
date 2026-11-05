// Linear's webhooks: verified over the raw body, then acted on. AGE-20 adds
// de-duplication and the queue.
import type { ErrorRequestHandler, Request, Response } from "express";
import {
  LINEAR_WEBHOOK_SIGNATURE_HEADER,
  LinearWebhookClient,
  type LinearWebhookPayload,
  type OAuthAppWebhookPayload,
} from "@linear/sdk/webhooks";
import type { Logger } from "pino";
import { inject, injectable } from "tsyringe";
import type { Config } from "./config.js";
import { empty } from "./http.js";
// A value import, not `import type`: tsyringe resolves it by its runtime class.
import { TokenStore } from "./tokenStore.js";
import { CONFIG, LOGGER } from "./tokens.js";

@injectable()
export class WebhookController {
  readonly #config: Config;
  readonly #tokens: TokenStore;
  readonly #logger: Logger;
  // Checks the HMAC over the raw body and that the signed webhookTimestamp is within
  // 60 s of now (FR-201, FR-202).
  readonly #webhooks: LinearWebhookClient;

  constructor(@inject(CONFIG) config: Config, tokens: TokenStore, @inject(LOGGER) logger: Logger) {
    this.#config = config;
    this.#tokens = tokens;
    this.#logger = logger;
    this.#webhooks = new LinearWebhookClient(config.linear.webhookSecret);
  }

  // The route's express.raw() leaves req.body as the bytes Linear sent, which the
  // HMAC covers. A request with no body leaves it undefined, and fails the check.
  receive = async (req: Request, res: Response): Promise<void> => {
    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = req.headers[LINEAR_WEBHOOK_SIGNATURE_HEADER];
    let payload: LinearWebhookPayload;
    try {
      // Throws on a bad signature or a stale timestamp; never returns false.
      payload = this.#webhooks.parseData(body, typeof signature === "string" ? signature : "");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.#reject(req, res, reason);
      return;
    }
    // The SDK types `type` as a plain string, so the union does not narrow on it.
    if (payload.type === "OAuthApp" && payload.action === "revoked") {
      if ((payload as OAuthAppWebhookPayload).oauthClientId === this.#config.linear.clientId) {
        await this.#tokens.clear("Linear sent an OAuthApp revoked webhook");
      } else {
        this.#logger.warn("ignoring an OAuthApp revoked webhook for another client");
      }
    }
    // Agent session events and notifications are acknowledged and dropped until AGE-20.
    empty(res, 200);
  };

  // For errors from the route's body parser.
  unreadableBody: ErrorRequestHandler = (err, req, res, next) => {
    if (err?.type === "entity.too.large") {
      empty(res, 413);
    } else if (err?.type === "encoding.unsupported") {
      // The parser never decompresses, so the HMAC would run over compressed bytes
      // and fail. Answer as that failed check would.
      this.#reject(req, res, `unsupported content encoding ${err.encoding}`);
    } else {
      next(err);
    }
  };

  #reject(req: Request, res: Response, reason: string): void {
    this.#logger.warn({ delivery: req.headers["linear-delivery"], reason }, "rejected a webhook");
    empty(res, 401);
  }
}
