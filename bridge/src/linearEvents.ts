// What the bridge does with each Linear event, once it has been acknowledged and
// taken off the queue. AGE-22 adds the agent session events.
import type { OAuthAppWebhookPayload } from "@linear/sdk/webhooks";
import type { Logger } from "pino";
import { inject, injectable } from "tsyringe";
import type { Config } from "./config.js";
// A value import, not `import type`: tsyringe resolves it by its runtime class.
import { TokenStore } from "./tokenStore.js";
import { CONFIG, LOGGER } from "./tokens.js";
import type { WebhookEvent, WebhookHandler } from "./webhookQueue.js";

@injectable()
export class LinearEvents implements WebhookHandler {
  constructor(
    @inject(CONFIG) private readonly config: Config,
    private readonly tokens: TokenStore,
    @inject(LOGGER) private readonly logger: Logger,
  ) {}

  async handle({ delivery, payload }: WebhookEvent): Promise<void> {
    // The SDK types `type` as a plain string, so the union does not narrow on it.
    if (payload.type === "OAuthApp" && payload.action === "revoked") {
      if ((payload as OAuthAppWebhookPayload).oauthClientId === this.config.linear.clientId) {
        await this.tokens.clear("Linear sent an OAuthApp revoked webhook");
      } else {
        this.logger.warn({ delivery }, "ignoring an OAuthApp revoked webhook for another client");
      }
      return;
    }
    // Agent session events and notifications are dropped until AGE-22.
    this.logger.debug({ delivery, type: payload.type, action: payload.action }, "dropped a webhook");
  }
}
