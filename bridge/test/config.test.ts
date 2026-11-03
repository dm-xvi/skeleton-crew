import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";

// The repo's shipped profiles, as the image copies them to /app/roles.
const repoRolesDir = new URL("../../roles/", import.meta.url).pathname;

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
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function rolesDirWith(files: { yaml?: string; prompt?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "roles-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "coder"));
  if (files.yaml !== undefined) writeFileSync(join(dir, "coder", "role.yaml"), files.yaml);
  if (files.prompt !== undefined) writeFileSync(join(dir, "coder", "prompt.md"), files.prompt);
  return dir;
}

function problemsFor(env: Record<string, string | undefined>, rolesDir = repoRolesDir): string[] {
  try {
    loadConfig(env, rolesDir);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    // NFR-06: no secret value ever reaches the message.
    for (const value of Object.values(validEnv)) {
      if (value.startsWith("secret-")) assert.ok(!err.message.includes(value));
    }
    return err.problems;
  }
  assert.fail("expected loadConfig to throw");
}

describe("loadConfig", () => {
  test("loads the shipped coder profile", () => {
    const config = loadConfig(validEnv, repoRolesDir);
    assert.equal(config.role.name, "coder");
    assert.equal(config.role.permissionMode, "acceptEdits");
    assert.match(config.role.prompt, /coder/);
    assert.equal(config.port, 3000);
    assert.equal(config.linear.webhookSecret, "secret-webhook-secret");
  });

  test("names a missing credential", () => {
    const problems = problemsFor({ ...validEnv, LINEAR_WEBHOOK_SECRET: undefined });
    assert.deepEqual(problems, ["LINEAR_WEBHOOK_SECRET is missing or empty."]);
  });

  test("treats an empty credential as missing", () => {
    const problems = problemsFor({ ...validEnv, CLAUDE_CODE_OAUTH_TOKEN: "" });
    assert.deepEqual(problems, ["CLAUDE_CODE_OAUTH_TOKEN is missing or empty."]);
  });

  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    test(`refuses ${name}`, () => {
      const problems = problemsFor({ ...validEnv, [name]: "secret-api-key" });
      assert.equal(problems.length, 1);
      assert.match(problems[0], new RegExp(`^${name} is set\\. API keys are not used`));
    });
  }

  test("reports every problem at once", () => {
    const problems = problemsFor({ ROLE: "coder", ANTHROPIC_API_KEY: "secret-api-key" });
    assert.equal(problems.length, 6);
  });

  test("requires ROLE", () => {
    assert.deepEqual(problemsFor({ ...validEnv, ROLE: undefined }), ["ROLE is missing or empty."]);
  });

  test("rejects a ROLE that is not a plain name", () => {
    const problems = problemsFor({ ...validEnv, ROLE: "../etc" });
    assert.match(problems[0], /^ROLE must be/);
  });

  test("names a missing profile", () => {
    const problems = problemsFor({ ...validEnv, ROLE: "reviewer" });
    assert.deepEqual(problems, [
      `${join(repoRolesDir, "reviewer", "role.yaml")} not found.`,
      `${join(repoRolesDir, "reviewer", "prompt.md")} not found.`,
    ]);
  });

  test("names a missing prompt.md", () => {
    const dir = rolesDirWith({ yaml: validYaml });
    assert.deepEqual(problemsFor(validEnv, dir), [`${join(dir, "coder", "prompt.md")} not found.`]);
  });

  test("rejects an empty prompt.md", () => {
    const dir = rolesDirWith({ yaml: validYaml, prompt: "  \n" });
    assert.deepEqual(problemsFor(validEnv, dir), [`${join(dir, "coder", "prompt.md")} is empty.`]);
  });

  test("rejects role.yaml that is not YAML", () => {
    const dir = rolesDirWith({ yaml: "name: [coder", prompt: "Hi." });
    assert.match(problemsFor(validEnv, dir)[0], /role\.yaml is not valid YAML/);
  });

  test("names each invalid field in role.yaml", () => {
    const yaml = validYaml
      .replace("permissionMode: acceptEdits", "permissionMode: yolo")
      .replace("maxTurns: 200", "maxTurns: 0")
      .concat("maxTurn: 5\n");
    const problems = problemsFor(validEnv, rolesDirWith({ yaml, prompt: "Hi." }));
    assert.equal(problems.length, 3);
    assert.match(problems.find((p) => p.includes("permissionMode")) ?? "", /role\.yaml: permissionMode:/);
    assert.match(problems.find((p) => p.includes(": maxTurns:")) ?? "", /role\.yaml: maxTurns:/);
    assert.match(problems.find((p) => p.includes("maxTurn\"")) ?? "", /Unrecognized key/);
  });

  test("rejects a missing field in role.yaml", () => {
    const yaml = validYaml.replace("model: default\n", "");
    const problems = problemsFor(validEnv, rolesDirWith({ yaml, prompt: "Hi." }));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /role\.yaml: model:/);
  });

  test("requires the profile name to match ROLE", () => {
    const yaml = validYaml.replace("name: coder", "name: reviewer");
    const problems = problemsFor(validEnv, rolesDirWith({ yaml, prompt: "Hi." }));
    assert.match(problems[0], /name is "reviewer" but ROLE is "coder"/);
  });

  test("checks PUBLIC_URL", () => {
    assert.deepEqual(problemsFor({ ...validEnv, PUBLIC_URL: "http://coder.example.com" }), [
      "PUBLIC_URL must be an https:// URL.",
    ]);
    assert.deepEqual(problemsFor({ ...validEnv, PUBLIC_URL: "https://coder.example.com/" }), [
      "PUBLIC_URL must not end with a slash.",
    ]);
  });

  test("checks PORT", () => {
    assert.equal(loadConfig({ ...validEnv, PORT: "8080" }, repoRolesDir).port, 8080);
    assert.deepEqual(problemsFor({ ...validEnv, PORT: "http" }), [
      "PORT must be an integer from 1 to 65535.",
    ]);
  });
});
