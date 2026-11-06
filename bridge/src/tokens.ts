// Injection tokens for dependencies that are not classes. A class is its own token.
import type { Logger } from "pino";
import type { InjectionToken } from "tsyringe";
import type { Config } from "./config.js";
import type { Fetch } from "./linearOAuth.js";
import type { WebhookHandler } from "./webhookQueue.js";

export const CONFIG: InjectionToken<Config> = Symbol("Config");
export const LOGGER: InjectionToken<Logger> = Symbol("Logger");
export const CLOCK: InjectionToken<() => number> = Symbol("Clock");
export const FETCH: InjectionToken<Fetch> = Symbol("Fetch");
// What the webhook queue hands each event to. Tests swap in their own.
export const WEBHOOK_HANDLER: InjectionToken<WebhookHandler> = Symbol("WebhookHandler");
