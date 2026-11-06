// Loggers for tests. Every line they write is also kept here, and noSecretsInLogs.ts
// checks after each test that none of it holds a token or a secret.
import { pino, type Logger } from "pino";
import { expect } from "vitest";

// Every secret a test uses starts with "secret-", except the webhook fixtures' signing secret.
export const SECRET_VALUES = /secret-|lin_wh_fixture_secret_not_real/;

export interface WrittenLine {
  // The test that made the logger, so a line written after it ends still names it.
  test: string | undefined;
  line: string;
}

let written: WrittenLine[] = [];

// A trace-level logger that appends each line it writes to `lines`.
export function captureLogs(lines: string[] = []): { logger: Logger; lines: string[] } {
  const test = expect.getState().currentTestName;
  const logger = pino({ level: "trace" }, {
    write: (line: string) => {
      lines.push(line);
      written.push({ test, line });
    },
  });
  return { logger, lines };
}

// Everything captured since the last call.
export function takeWrittenLogs(): WrittenLine[] {
  const all = written;
  written = [];
  return all;
}
