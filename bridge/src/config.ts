// The only module that reads ROLE or knows where role profiles live. Everything
// else gets the loaded profile and credentials from loadConfig().
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// The image copies roles/ to /app/roles; dist/config.js sits in /app/dist.
const DEFAULT_ROLES_DIR = new URL("../roles/", import.meta.url).pathname;

const permissionModes = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const satisfies readonly PermissionMode[];

const roleProfileSchema = z.strictObject({
  name: z.string().min(1),
  model: z.string().min(1),
  permissionMode: z.enum(permissionModes),
  maxTurns: z.int().positive(),
  allowedTools: z.array(z.string().min(1)),
  disallowedTools: z.array(z.string().min(1)),
  bridgeTools: z.array(z.string().min(1)),
  triggers: z.array(z.enum(["delegated", "mentioned"])).min(1),
  github: z.strictObject({
    branchPrefix: z.string().min(1),
    draftPullRequests: z.boolean(),
  }),
});

export type RoleProfile = z.infer<typeof roleProfileSchema> & {
  // prompt.md, appended to Claude's system prompt.
  prompt: string;
};

export interface Config {
  port: number;
  role: RoleProfile;
  claude: { oauthToken: string };
  linear: {
    clientId: string;
    clientSecret: string;
    webhookSecret: string;
    publicUrl: string;
  };
  // GitHub credentials join here with the coder's GitHub App (AGE-34).
}

// Empty counts as missing: `KEY=` in an env file sets an empty string.
const requiredEnv = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "PUBLIC_URL",
] as const;

// Either one outranks CLAUDE_CODE_OAUTH_TOKEN and bills the API instead of the subscription.
const forbiddenEnv = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

// Collects every problem before failing, so one restart shows them all.
// Messages name variables and files, never their values.
export function loadConfig(env: Env, rolesDir = DEFAULT_ROLES_DIR): Config {
  const problems: string[] = [];

  for (const name of forbiddenEnv) {
    if (env[name]) {
      problems.push(
        `${name} is set. API keys are not used: Claude runs on the subscription token ` +
          `(CLAUDE_CODE_OAUTH_TOKEN). Remove ${name} from the environment.`,
      );
    }
  }

  for (const name of requiredEnv) {
    if (!env[name]) problems.push(`${name} is missing or empty.`);
  }

  const publicUrl = env.PUBLIC_URL;
  if (publicUrl) {
    const url = URL.parse(publicUrl);
    if (!url || url.protocol !== "https:") {
      problems.push("PUBLIC_URL must be an https:// URL.");
    } else if (publicUrl.endsWith("/")) {
      problems.push("PUBLIC_URL must not end with a slash.");
    }
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push("PORT must be an integer from 1 to 65535.");
  }

  const role = loadRole(env.ROLE, rolesDir, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    port,
    role: role!,
    claude: { oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN! },
    linear: {
      clientId: env.LINEAR_CLIENT_ID!,
      clientSecret: env.LINEAR_CLIENT_SECRET!,
      webhookSecret: env.LINEAR_WEBHOOK_SECRET!,
      publicUrl: publicUrl!,
    },
  };
}

function loadRole(
  roleName: string | undefined,
  rolesDir: string,
  problems: string[],
): RoleProfile | undefined {
  if (!roleName) {
    problems.push("ROLE is missing or empty.");
    return undefined;
  }
  // ROLE becomes a path segment, so keep it to a plain name.
  if (!/^[a-z][a-z0-9-]*$/.test(roleName)) {
    problems.push("ROLE must be lowercase letters, digits and hyphens, starting with a letter.");
    return undefined;
  }

  const roleDir = join(rolesDir, roleName);
  const yamlPath = join(roleDir, "role.yaml");
  const promptPath = join(roleDir, "prompt.md");

  const yamlText = readProfileFile(yamlPath, problems);
  const prompt = readProfileFile(promptPath, problems);
  if (prompt !== undefined && prompt.trim() === "") {
    problems.push(`${promptPath} is empty.`);
  }
  if (yamlText === undefined) return undefined;

  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    problems.push(`${yamlPath} is not valid YAML: ${(err as Error).message}`);
    return undefined;
  }

  const parsed = roleProfileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.length > 0 ? issue.path.join(".") : "(top level)";
      problems.push(`${yamlPath}: ${field}: ${issue.message}`);
    }
    return undefined;
  }
  if (parsed.data.name !== roleName) {
    problems.push(`${yamlPath}: name is "${parsed.data.name}" but ROLE is "${roleName}".`);
  }

  return prompt === undefined ? undefined : { ...parsed.data, prompt };
}

function readProfileFile(path: string, problems: string[]): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    problems.push(code === "ENOENT" ? `${path} not found.` : `${path} could not be read (${code}).`);
    return undefined;
  }
}
