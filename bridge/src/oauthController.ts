// The Linear install: /oauth/install sends the browser to Linear's consent screen,
// and /oauth/callback exchanges the code and stores the tokens.
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import { inject, injectable } from "tsyringe";
import type { Config } from "./config.js";
import { text } from "./http.js";
// Value imports, not `import type`: tsyringe resolves these by their runtime class.
import { LinearOAuth } from "./linearOAuth.js";
import { TokenStore } from "./tokenStore.js";
import { CLOCK, CONFIG, LOGGER } from "./tokens.js";

// Long enough to read Linear's consent screen and approve.
const INSTALL_STATE_TTL_MS = 10 * 60 * 1000;

@injectable()
export class OAuthController {
  // One-time CSRF states for installs in flight, with their expiry. In memory is
  // enough: an install that spans a restart just starts over. Shared by install
  // and callback, so the container must hold one controller per app.
  readonly #installStates = new Map<string, number>();

  constructor(
    @inject(CONFIG) private readonly config: Config,
    private readonly oauth: LinearOAuth,
    private readonly tokens: TokenStore,
    @inject(LOGGER) private readonly logger: Logger,
    @inject(CLOCK) private readonly now: () => number,
  ) {}

  // Handlers are arrow properties so Express can call them unbound.
  install = (_req: Request, res: Response): void => {
    const at = this.now();
    for (const [state, expiresAt] of this.#installStates) {
      if (expiresAt <= at) this.#installStates.delete(state);
    }
    const state = randomBytes(32).toString("base64url");
    this.#installStates.set(state, at + INSTALL_STATE_TTL_MS);
    res.writeHead(302, { location: this.oauth.authorizeUrl(state) }).end();
  };

  // Express sends a rejection to the app's error handler, which answers 500.
  callback = async (req: Request, res: Response): Promise<void> => {
    // URLSearchParams, not req.query: a repeated key stays a single string.
    const params = new URL(req.originalUrl, "http://bridge").searchParams;
    const state = params.get("state");
    const expiresAt = state ? this.#installStates.get(state) : undefined;
    if (state) this.#installStates.delete(state);
    if (expiresAt === undefined || expiresAt <= this.now()) {
      this.logger.warn("OAuth callback with an unknown or expired state");
      text(res, 400, "This install link has expired or was already used. Start again at /oauth/install.");
      return;
    }

    const error = params.get("error");
    if (error) {
      this.logger.warn({ error }, "Linear install was not approved");
      text(res, 400, `Linear did not approve the install (${error}). Start again at /oauth/install.`);
      return;
    }
    const code = params.get("code");
    if (!code) {
      text(res, 400, "Linear sent no authorization code. Start again at /oauth/install.");
      return;
    }

    const tokenResponse = await this.oauth.exchangeCode(code);
    const appUser = await this.oauth.appUser(tokenResponse.access_token);
    // /oauth/install is public. If the OAuth app is ever made public, someone else's
    // workspace must not be able to replace the install.
    const existing = await this.tokens.installation();
    if (existing && existing.organizationId !== appUser.organizationId) {
      this.logger.warn({ organizationId: appUser.organizationId }, "refused an install from another workspace");
      text(res, 409, `${this.config.role.name} is already installed in another Linear workspace. Revoke it there first.`);
      return;
    }
    await this.tokens.save(tokenResponse, appUser);
    this.logger.info({ ...appUser, scope: tokenResponse.scope }, "installed in Linear");
    text(res, 200, `${this.config.role.name} is installed in Linear. You can close this page.`);
  };
}
