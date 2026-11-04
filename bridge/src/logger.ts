// The bridge's one logger. It writes newline-delimited JSON to stdout, so
// `docker compose logs` shows it today and anything that tails stdout can read it later.
// It does not depend on loadConfig(): a bad config has to be logged too.
import { pino, type Level } from "pino";

type Env = Record<string, string | undefined>;

const levels = Object.keys(pino.levels.values);

export function isLogLevel(value: string): value is Level {
  return levels.includes(value);
}

// LOG_LEVEL wins. Otherwise development logs everything and the image (NODE_ENV=production)
// logs info and above. loadConfig() reports an invalid LOG_LEVEL, so it falls back here.
export function logLevel(env: Env): Level {
  if (env.LOG_LEVEL && isLogLevel(env.LOG_LEVEL)) return env.LOG_LEVEL;
  return env.NODE_ENV === "development" ? "trace" : "info";
}

export const logger = pino({ level: logLevel(process.env) });
