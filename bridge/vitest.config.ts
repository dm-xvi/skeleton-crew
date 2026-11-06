import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: [
      // tsyringe needs the Reflect metadata API; server.ts loads it in production.
      "reflect-metadata",
      "./test/noSecretsInLogs.ts",
    ],
  },
});
