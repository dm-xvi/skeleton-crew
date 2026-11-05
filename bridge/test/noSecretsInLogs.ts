// A setup file: fails any test whose captured logs hold a token or a secret.
import { afterEach, expect } from "vitest";
import { SECRET_VALUES, takeWrittenLogs } from "./logs.js";

afterEach(() => {
  expect(takeWrittenLogs()).not.toMatch(SECRET_VALUES);
});
