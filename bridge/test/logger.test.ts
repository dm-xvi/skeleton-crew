import { describe, expect, test } from "vitest";
import { logLevel } from "../src/logger.js";

describe("logLevel", () => {
  test("logs info and above by default", () => {
    expect(logLevel({})).toBe("info");
    expect(logLevel({ NODE_ENV: "production" })).toBe("info");
  });

  test("logs everything in development", () => {
    expect(logLevel({ NODE_ENV: "development" })).toBe("trace");
  });

  test("LOG_LEVEL wins", () => {
    expect(logLevel({ LOG_LEVEL: "debug", NODE_ENV: "production" })).toBe("debug");
    expect(logLevel({ LOG_LEVEL: "warn", NODE_ENV: "development" })).toBe("warn");
  });

  test("ignores an invalid LOG_LEVEL, which loadConfig() reports", () => {
    expect(logLevel({ LOG_LEVEL: "verbose" })).toBe("info");
    expect(logLevel({ LOG_LEVEL: "verbose", NODE_ENV: "development" })).toBe("trace");
  });
});
