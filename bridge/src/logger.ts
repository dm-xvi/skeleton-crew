// The bridge's one logger. It writes newline-delimited JSON to stdout, so
// `docker compose logs` shows it today and anything that tails stdout can read it later.
// It does not depend on loadConfig(): a bad config has to be logged too.
import { pino } from "pino";

export const logger = pino();
