// Linear's webhooks: verified over the raw body, then acted on. AGE-20 adds
// de-duplication and the queue.
import type { Request, Response } from "express";
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
  // Checks the HMAC over the raw body and that the signed webhookTimestamp is within
  // 60 s of now (FR-201, FR-202).
  readonly #webhooks: LinearWebhookClient;

  constructor(
    @inject(CONFIG) private readonly config: Config,
    private readonly tokens: TokenStore,
    @inject(LOGGER) private readonly logger: Logger,
  ) {
    this.#webhooks = new LinearWebhookClient(config.linear.webhookSecret);
  }

  // The route's rawBody() leaves req.body as the bytes Linear sent, which the HMAC
  // covers. A request with no body has zero bytes, and fails the check.
  receive = async (req: Request, res: Response): Promise<void> => {
    // Nothing is decompressed, so a body labelled compressed is not what Linear signed.
    const encoding = (req.headers["content-encoding"] ?? "identity").toLowerCase();
    if (encoding !== "identity") {
      this.#reject(req, res, `unsupported content encoding ${encoding}`);
      return;
    }
    const body: Buffer = req.body;
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
      if ((payload as OAuthAppWebhookPayload).oauthClientId === this.config.linear.clientId) {
        await this.tokens.clear("Linear sent an OAuthApp revoked webhook");
      } else {
        this.logger.warn("ignoring an OAuthApp revoked webhook for another client");
      }
    }
    // Agent session events and notifications are acknowledged and dropped until AGE-20.
    empty(res, 200);
  };

  #reject(req: Request, res: Response, reason: string): void {
    this.logger.warn({ delivery: req.headers["linear-delivery"], reason }, "rejected a webhook");
    empty(res, 401);
  }
}
