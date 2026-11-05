// Loggers for tests. Every line they write is also kept here, and noSecretsInLogs.ts
// checks after each test that none of it holds a token or a secret.
import { pino, type Logger } from "pino";

// Every secret a test uses starts with "secret-", except the webhook fixtures' signing secret.
export const SECRET_VALUES = /secret-|lin_wh_fixture_secret_not_real/;

let written: string[] = [];

// A trace-level logger and the lines it writes.
export function captureLogs(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino({ level: "trace" }, {
    write: (line: string) => {
      lines.push(line);
      written.push(line);
    },
  });
  return { logger, lines };
}

// Everything captured since the last call.
export function takeWrittenLogs(): string {
  const all = written.join("");
  written = [];
  return all;
}
