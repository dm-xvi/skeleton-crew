// A setup file: fails any test whose captured logs hold a token or a secret.
import { afterAll, afterEach, expect } from "vitest";
import { SECRET_VALUES, takeWrittenLogs } from "./logs.js";

function checkWrittenLogs(): void {
  for (const { test, line } of takeWrittenLogs()) {
    expect(line, `logged by "${test ?? "a logger made outside a test"}"`).not.toMatch(SECRET_VALUES);
  }
}

afterEach(checkWrittenLogs);
// Lines written after the file's last test ended. The hooks run back to back, so give
// work that finishes just after (a timer, a last request) a moment to log.
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  checkWrittenLogs();
});
