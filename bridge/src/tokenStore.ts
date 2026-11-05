// The coder's Linear install: tokens and app user id, kept in one JSON file on the
// data volume so they survive a restart. The file is the source of truth and is
// read on every use, so editing expiresAt by hand (FR-105's check) takes effect at once.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { LinearOAuthError, type AppUser, type LinearOAuth, type TokenResponse } from "./linearOAuth.js";

// Refresh this long before expiry, so a token never lapses mid-request.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const installationSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  // ISO 8601, so a person can read it and set it to the past.
  expiresAt: z.iso.datetime({ offset: true }),
  scope: z.string(),
  appUserId: z.string().min(1),
  organizationId: z.string().min(1),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type Installation = z.infer<typeof installationSchema>;

// The coder is not installed, or Linear no longer accepts its tokens.
// Visiting /oauth/install fixes it.
export class NotInstalledError extends Error {
  constructor(reason: string) {
    super(`The coder is not installed in Linear (${reason}). Visit /oauth/install.`);
    this.name = "NotInstalledError";
  }
}

export interface TokenStoreOptions {
  file: string;
  oauth: LinearOAuth;
  logger: Logger;
  now?: () => number;
}

export class TokenStore {
  readonly #file: string;
  readonly #oauth: LinearOAuth;
  readonly #logger: Logger;
  readonly #now: () => number;
  // Shared by concurrent callers. Refresh tokens rotate, so two parallel refreshes
  // would race and one of them could lose its token.
  #refreshing: Promise<string> | undefined;
  // Bumped by save() and clear(), so a refresh that finishes after a revoke or a
  // reinstall doesn't write stale tokens back.
  #generation = 0;

  constructor(options: TokenStoreOptions) {
    this.#file = options.file;
    this.#oauth = options.oauth;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  // Everything but the tokens, or undefined when not installed.
  async installation(): Promise<Omit<Installation, "accessToken" | "refreshToken"> | undefined> {
    const stored = await this.#read();
    if (!stored) return undefined;
    const { accessToken, refreshToken, ...rest } = stored;
    return rest;
  }

  // A valid access token, refreshed first if it expires within the margin.
  async accessToken(): Promise<string> {
    // Taken before the read: a revoke that lands while the file is read still counts.
    const generation = this.#generation;
    const stored = await this.#read();
    if (!stored) throw new NotInstalledError("no stored tokens");
    if (Date.parse(stored.expiresAt) - this.#now() > REFRESH_MARGIN_MS) return stored.accessToken;
    this.#refreshing ??= this.#refresh(stored, generation).finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  // Called by the OAuth callback after a fresh install.
  async save(tokens: TokenResponse, appUser: AppUser): Promise<void> {
    this.#generation++;
    await this.#write(this.#fromResponse(tokens, appUser));
  }

  // Forgets the install. Called on an OAuthApp revoked webhook, when a refresh is
  // refused, and by the Linear client on a 401 (AGE-16: the webhook doesn't always come).
  async clear(reason: string): Promise<void> {
    this.#generation++;
    await rm(this.#file, { force: true });
    this.#logger.warn({ reason }, "deleted the stored Linear tokens");
  }

  async #refresh(stored: Installation, generation: number): Promise<string> {
    let tokens: TokenResponse;
    try {
      tokens = await this.#oauth.refresh(stored.refreshToken);
    } catch (err) {
      // 400 (invalid_grant) or 401: the refresh token is dead, so the install is.
      // Anything else (a network error, a 5xx) may pass, so keep the tokens.
      const refused = err instanceof LinearOAuthError && (err.status === 400 || err.status === 401);
      if (!refused) throw err;
      if (generation !== this.#generation) return this.#currentAccessToken();
      await this.clear(`token refresh refused: ${err.message}`);
      throw new NotInstalledError("Linear refused the token refresh");
    }
    if (generation !== this.#generation) return this.#currentAccessToken();
    const refreshed = this.#fromResponse(tokens, stored);
    await this.#write(refreshed);
    this.#logger.info({ expiresAt: refreshed.expiresAt }, "refreshed the Linear access token");
    return refreshed.accessToken;
  }

  // After a revoke or reinstall during a refresh, the file has the answer, not the
  // refresh's result.
  async #currentAccessToken(): Promise<string> {
    const current = await this.#read();
    if (!current) throw new NotInstalledError("revoked while refreshing");
    return current.accessToken;
  }

  #fromResponse(tokens: TokenResponse, appUser: AppUser): Installation {
    const now = this.#now();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(now + tokens.expires_in * 1000).toISOString(),
      scope: tokens.scope,
      appUserId: appUser.appUserId,
      organizationId: appUser.organizationId,
      updatedAt: new Date(now).toISOString(),
    };
  }

  async #read(): Promise<Installation | undefined> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const parsed = installationSchema.safeParse(raw);
    if (!parsed.success) {
      // Name the fields only: the file holds tokens.
      const fields = parsed.error.issues.map((i) => i.path.join(".") || "(top level)");
      this.#logger.error({ file: this.#file, fields }, "stored Linear tokens are invalid; reinstall");
      return undefined;
    }
    return parsed.data;
  }

  // Write a temp file and rename it over the real one, so a crash never leaves half a file.
  async #write(installation: Installation): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(installation, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, this.#file);
  }
}
