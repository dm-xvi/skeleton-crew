// A valid config for the coder role, with fake credentials and its own data directory.
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../src/config.js";

const repoRolesDir = fileURLToPath(new URL("../../roles/", import.meta.url));

export function testConfig(dataDir: string): Config {
  return loadConfig(
    {
      ROLE: "coder",
      CLAUDE_CODE_OAUTH_TOKEN: "secret-oauth-token",
      LINEAR_CLIENT_ID: "client-id",
      LINEAR_CLIENT_SECRET: "secret-client-secret",
      LINEAR_WEBHOOK_SECRET: "secret-webhook-secret",
      PUBLIC_URL: "https://coder.example.com",
      DATA_DIR: dataDir,
    },
    repoRolesDir,
  );
}
