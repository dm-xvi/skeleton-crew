import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

// The repo's shipped profiles, as the image copies them to /app/roles.
const repoRolesDir = fileURLToPath(new URL("../../roles/", import.meta.url));

const validEnv = {
  ROLE: "coder",
  CLAUDE_CODE_OAUTH_TOKEN: "secret-oauth-token",
  LINEAR_CLIENT_ID: "secret-client-id",
  LINEAR_CLIENT_SECRET: "secret-client-secret",
  LINEAR_WEBHOOK_SECRET: "secret-webhook-secret",
  PUBLIC_URL: "https://coder.example.com",
};

const validYaml = `
name: coder
model: default
permissionMode: acceptEdits
maxTurns: 200
allowedTools: [Read]
disallowedTools: []
bridgeTools: []
triggers: [delegated]
github:
  branchPrefix: claude/
  draftPullRequests: true
`;

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function rolesDirWith(files: { yaml?: string; prompt?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "roles-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "coder"));
  if (files.yaml !== undefined) writeFileSync(join(dir, "coder", "role.yaml"), files.yaml);
  if (files.prompt !== undefined) writeFileSync(join(dir, "coder", "prompt.md"), files.prompt);
  return dir;
}

function problemsFor(env: Record<string, string | undefined>, rolesDir = repoRolesDir): string[] {
  let error: unknown;
  try {
    loadConfig(env, rolesDir);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ConfigError);
  const { message, problems } = error as ConfigError;
  // NFR-06: no secret value ever reaches the message.
  for (const value of Object.values(validEnv)) {
    if (value.startsWith("secret-")) expect(message).not.toContain(value);
  }
  return problems;
}

describe("loadConfig", () => {
  test("loads the shipped coder profile", () => {
    const config = loadConfig(validEnv, repoRolesDir);
    expect(config.role.name).toBe("coder");
    expect(config.role.permissionMode).toBe("acceptEdits");
    expect(config.role.prompt).toMatch(/coder/);
    expect(config.port).toBe(3000);
    expect(config.linear.webhookSecret).toBe("secret-webhook-secret");
  });

  test("names a missing credential", () => {
    const problems = problemsFor({ ...validEnv, LINEAR_WEBHOOK_SECRET: undefined });
    expect(problems).toEqual(["LINEAR_WEBHOOK_SECRET is missing or empty."]);
  });

  test("treats an empty credential as missing", () => {
    const problems = problemsFor({ ...validEnv, CLAUDE_CODE_OAUTH_TOKEN: "" });
    expect(problems).toEqual(["CLAUDE_CODE_OAUTH_TOKEN is missing or empty."]);
  });

  test.each(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])("refuses %s", (name) => {
    const problems = problemsFor({ ...validEnv, [name]: "secret-api-key" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${name} is set\\. API keys are not used`));
  });

  test("reports every problem at once", () => {
    const problems = problemsFor({ ROLE: "coder", ANTHROPIC_API_KEY: "secret-api-key" });
    expect(problems).toHaveLength(6);
  });

  test("requires ROLE before looking for a profile", () => {
    expect(problemsFor({ ...validEnv, ROLE: undefined })).toEqual(["ROLE is missing or empty."]);
    expect(problemsFor({ ...validEnv, ROLE: "" })).toEqual(["ROLE is missing or empty."]);
  });

  test("rejects a ROLE that is not a plain name", () => {
    const problems = problemsFor({ ...validEnv, ROLE: "../etc" });
    expect(problems[0]).toMatch(/^ROLE must be/);
  });

  test("names a missing profile", () => {
    const problems = problemsFor({ ...validEnv, ROLE: "reviewer" });
    expect(problems).toEqual([
      `${join(repoRolesDir, "reviewer", "role.yaml")} not found.`,
      `${join(repoRolesDir, "reviewer", "prompt.md")} not found.`,
    ]);
  });

  test("names a missing prompt.md", () => {
    const dir = rolesDirWith({ yaml: validYaml });
    expect(problemsFor(validEnv, dir)).toEqual([`${join(dir, "coder", "prompt.md")} not found.`]);
  });

  test("rejects an empty prompt.md", () => {
    const dir = rolesDirWith({ yaml: validYaml, prompt: "  \n" });
    expect(problemsFor(validEnv, dir)).toEqual([`${join(dir, "coder", "prompt.md")} is empty.`]);
  });

  test("rejects role.yaml that is not YAML", () => {
    const dir = rolesDirWith({ yaml: "name: [coder", prompt: "Hi." });
    expect(problemsFor(validEnv, dir)[0]).toMatch(/role\.yaml is not valid YAML/);
  });

  test("names each invalid field in role.yaml", () => {
    const yaml = validYaml
      .replace("permissionMode: acceptEdits", "permissionMode: yolo")
      .replace("maxTurns: 200", "maxTurns: 0")
      .concat("maxTurn: 5\n");
    const problems = problemsFor(validEnv, rolesDirWith({ yaml, prompt: "Hi." }));
    expect(problems).toHaveLength(3);
    expect(problems).toContainEqual(expect.stringMatching(/role\.yaml: permissionMode:/));
    expect(problems).toContainEqual(expect.stringMatching(/role\.yaml: maxTurns:/));
    expect(problems).toContainEqual(expect.stringMatching(/Unrecognized key: "maxTurn"/));
  });

  test("rejects a missing field in role.yaml", () => {
    const yaml = validYaml.replace("model: default\n", "");
    const problems = problemsFor(validEnv, rolesDirWith({ yaml, prompt: "Hi." }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/role\.yaml: model:/);
  });

  test("requires the profile name to match ROLE", () => {
    const yaml = validYaml.replace("name: coder", "name: reviewer");
    const problems = problemsFor(validEnv, rolesDirWith({ yaml, prompt: "Hi." }));
    expect(problems[0]).toMatch(/name is "reviewer" but ROLE is "coder"/);
  });

  test("checks PUBLIC_URL", () => {
    expect(problemsFor({ ...validEnv, PUBLIC_URL: "http://coder.example.com" })).toEqual([
      "PUBLIC_URL must be an https:// URL.",
    ]);
    expect(problemsFor({ ...validEnv, PUBLIC_URL: "https://coder.example.com/" })).toEqual([
      "PUBLIC_URL must not end with a slash.",
    ]);
  });

  test("checks PORT", () => {
    expect(loadConfig({ ...validEnv, PORT: "8080" }, repoRolesDir).port).toBe(8080);
    expect(problemsFor({ ...validEnv, PORT: "http" })).toEqual([
      "PORT must be an integer from 1 to 65535.",
    ]);
  });

  test("checks DATA_DIR", () => {
    expect(loadConfig(validEnv, repoRolesDir).dataDir).toBe("/data");
    expect(loadConfig({ ...validEnv, DATA_DIR: "/tmp/data" }, repoRolesDir).dataDir).toBe("/tmp/data");
    expect(problemsFor({ ...validEnv, DATA_DIR: "data" })).toEqual(["DATA_DIR must be an absolute path."]);
  });

  test("checks LOG_LEVEL", () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: "debug" }, repoRolesDir)).not.toThrow();
    expect(problemsFor({ ...validEnv, LOG_LEVEL: "verbose" })).toEqual([
      "LOG_LEVEL must be one of fatal, error, warn, info, debug, trace.",
    ]);
  });
});
