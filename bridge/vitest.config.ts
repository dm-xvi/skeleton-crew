import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsyringe needs the Reflect metadata API; server.ts loads it in production.
  test: { setupFiles: ["reflect-metadata"] },
});
