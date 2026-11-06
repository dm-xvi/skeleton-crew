// The in-process queue between the webhook route and the work a delivery starts.
// The route acknowledges a delivery and pushes it here, so slow work never holds up
// Linear's 200 (FR-204, NFR-01).
import type { LinearWebhookPayload } from "@linear/sdk/webhooks";
import type { Logger } from "pino";
import { inject, injectable } from "tsyringe";
import { LOGGER, WEBHOOK_HANDLER } from "./tokens.js";

export interface WebhookEvent {
  // Undefined only if Linear left the header off a correctly signed delivery.
  delivery: string | undefined;
  payload: LinearWebhookPayload;
}

export interface WebhookHandler {
  handle(event: WebhookEvent): Promise<void>;
}

@injectable()
export class WebhookQueue {
  // One event at a time, in arrival order, so a session's `created` is handled
  // before its `prompted`. A handler that starts long work should not await it.
  #tail: Promise<void> = Promise.resolve();

  constructor(
    @inject(WEBHOOK_HANDLER) private readonly handler: WebhookHandler,
    @inject(LOGGER) private readonly logger: Logger,
  ) {}

  push(event: WebhookEvent): void {
    this.#tail = this.#tail.then(() => this.#run(event));
  }

  // Settles once everything pushed so far has been handled.
  idle(): Promise<void> {
    return this.#tail;
  }

  // Never rejects: a rejection here would stop the queue, and an unhandled one
  // stops the bridge.
  async #run({ delivery, payload }: WebhookEvent): Promise<void> {
    try {
      await this.handler.handle({ delivery, payload });
    } catch (err) {
      this.logger.error(
        { err, delivery, type: payload.type, action: payload.action },
        "handling a webhook failed",
      );
    }
  }
}
