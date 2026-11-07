// Linear's webhooks: verified over the raw body, de-duplicated, acknowledged, and
// only then handed to the queue.
import type { Request, RequestHandler, Response } from "express";
import {
  LINEAR_WEBHOOK_SIGNATURE_HEADER,
  LinearWebhookClient,
  type LinearWebhookPayload,
} from "@linear/sdk/webhooks";
import type { Logger } from "pino";
import { inject, injectable } from "tsyringe";
import type { Config } from "./config.js";
import { empty } from "./http.js";
// Value imports, not `import type`: tsyringe resolves them by their runtime class.
import { SeenDeliveries } from "./seenDeliveries.js";
import { CONFIG, LOGGER } from "./tokens.js";
import { WebhookQueue } from "./webhookQueue.js";

@injectable()
export class WebhookController {
  // Checks the HMAC over the raw body and that the signed webhookTimestamp is within
  // 60 s of now (FR-201, FR-202).
  readonly #webhooks: LinearWebhookClient;

  constructor(
    @inject(CONFIG) config: Config,
    private readonly seen: SeenDeliveries,
    private readonly queue: WebhookQueue,
    @inject(LOGGER) private readonly logger: Logger,
  ) {
    this.#webhooks = new LinearWebhookClient(config.linear.webhookSecret);
  }

  // Runs before the body is read, so the logged ack time includes reading it. Every
  // request is logged, the 401s and 413s too. On "close", not "finish", which never
  // fires when the connection drops first; `finished` says whether the answer got out.
  timed: RequestHandler = (req, res, next) => {
    const start = performance.now();
    res.on("close", () => {
      // performance.now(), not Date: tests fake Date to match the fixtures.
      const ackMs = Math.round(performance.now() - start);
      this.logger.info(
        {
          delivery: req.headers["linear-delivery"],
          event: req.headers["linear-event"],
          // Until headers go out, statusCode is Node's default 200, not an answer.
          status: res.headersSent ? res.statusCode : undefined,
          finished: res.writableFinished,
          ackMs,
        },
        "answered a webhook",
      );
    });
    next();
  };

  // The route's rawBody() leaves req.body as the bytes Linear sent, which the HMAC
  // covers. A request with no body has zero bytes, and fails the check.
  receive = (req: Request, res: Response): void => {
    // Nothing is decompressed, so a body labelled compressed is not what Linear signed.
    const encoding = (req.headers["content-encoding"] ?? "identity").toLowerCase();
    if (encoding !== "identity") {
      this.#reject(req, res, `unsupported content encoding ${encoding}`);
      return;
    }
    const body: Buffer = req.body;
    const header = req.headers[LINEAR_WEBHOOK_SIGNATURE_HEADER];
    const signature = typeof header === "string" ? header : "";
    let payload: LinearWebhookPayload;
    try {
      // Throws on a bad signature or a stale timestamp; never returns false.
      payload = this.#webhooks.parseData(body, signature);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.#reject(req, res, reason);
      return;
    }
    // Only now: a forged request must not get a real delivery id marked as seen.
    const deliveryHeader = req.headers["linear-delivery"];
    const delivery = typeof deliveryHeader === "string" && deliveryHeader !== "" ? deliveryHeader : undefined;
    if (delivery === undefined) {
      this.logger.warn({ type: payload.type, action: payload.action }, "a signed webhook has no Linear-Delivery id");
    }
    // The signature is checked too: the delivery id isn't signed, so a copy of a signed
    // request replayed with a new id would otherwise pass. Both are recorded either way.
    const firstSignature = this.seen.firstTime(`signature:${signature}`);
    const firstDelivery = delivery === undefined || this.seen.firstTime(`delivery:${delivery}`);
    empty(res, 200);
    if (firstSignature && firstDelivery) {
      this.queue.push({ delivery, payload });
    } else {
      this.logger.info({ delivery, type: payload.type, action: payload.action }, "ignored a duplicate webhook");
    }
  };

  #reject(req: Request, res: Response, reason: string): void {
    this.logger.warn({ delivery: req.headers["linear-delivery"], reason }, "rejected a webhook");
    empty(res, 401);
  }
}
