// Injection tokens for dependencies that are not classes. A class is its own token.
import type { Logger } from "pino";
import type { InjectionToken } from "tsyringe";
import type { Config } from "./config.js";
import type { Fetch } from "./linearOAuth.js";

export const CONFIG: InjectionToken<Config> = Symbol("Config");
export const LOGGER: InjectionToken<Logger> = Symbol("Logger");
export const CLOCK: InjectionToken<() => number> = Symbol("Clock");
export const FETCH: InjectionToken<Fetch> = Symbol("Fetch");
