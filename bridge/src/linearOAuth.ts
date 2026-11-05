// Linear's OAuth endpoints, for the authorization_code grant with actor=app that
// AGE-16 chose. Never add the client_credentials grant: minting one installs a
// teamless bot that cannot be mentioned or delegated to.
import { z } from "zod";

export type Fetch = typeof fetch;

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";

// app:assignable and app:mentionable make the bot a delegate and an @-mention target.
export const scopes = ["read", "write", "app:assignable", "app:mentionable"] as const;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

const viewerResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      id: z.string().min(1),
      app: z.boolean(),
      organization: z.object({ id: z.string().min(1) }),
    }),
  }),
});

export interface AppUser {
  appUserId: string;
  organizationId: string;
}

// Carries Linear's HTTP status and OAuth error code, never a response body:
// token responses hold secrets.
export class LinearOAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "LinearOAuthError";
  }
}

export interface LinearOAuthOptions {
  clientId: string;
  clientSecret: string;
  // Must match the redirect URI registered on the OAuth app, byte for byte.
  redirectUri: string;
  fetch?: Fetch;
}

export class LinearOAuth {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #redirectUri: string;
  readonly #fetch: Fetch;

  constructor(options: LinearOAuthOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#redirectUri = options.redirectUri;
    this.#fetch = options.fetch ?? fetch;
  }

  authorizeUrl(state: string): string {
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.#clientId,
      redirect_uri: this.#redirectUri,
      response_type: "code",
      scope: scopes.join(","),
      actor: "app",
      state,
    }).toString();
    return url.toString();
  }

  exchangeCode(code: string): Promise<TokenResponse> {
    return this.#token({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.#redirectUri,
    });
  }

  // Linear rotates refresh tokens: the response carries a new one, and the old one
  // stops working after a 30-minute grace period.
  refresh(refreshToken: string): Promise<TokenResponse> {
    return this.#token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  // The app user is the bot itself; its id is what sessions and mentions point at.
  async appUser(accessToken: string): Promise<AppUser> {
    const res = await this.#fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ query: "{ viewer { id app organization { id } } }" }),
    });
    if (!res.ok) throw new LinearOAuthError(`viewer query returned HTTP ${res.status}`, res.status);
    const parsed = viewerResponseSchema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw new LinearOAuthError("viewer query returned an unexpected shape");
    const { viewer } = parsed.data.data;
    if (!viewer.app) {
      throw new LinearOAuthError("the token belongs to a person, not the app: install with actor=app");
    }
    return { appUserId: viewer.id, organizationId: viewer.organization.id };
  }

  async #token(params: Record<string, string>): Promise<TokenResponse> {
    const res = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...params,
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
      }),
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const code = z.object({ error: z.string() }).safeParse(body).data?.error;
      throw new LinearOAuthError(
        `${params.grant_type} grant returned HTTP ${res.status}${code ? ` (${code})` : ""}`,
        res.status,
        code,
      );
    }
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new LinearOAuthError(`${params.grant_type} grant returned an unexpected shape`, res.status);
    }
    return parsed.data;
  }
}
