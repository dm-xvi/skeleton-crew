# Linear install grants ([AGE-16](https://linear.app/scriptorium/issue/AGE-16), throwaway)

Compares the two ways to get an `app`-actor token for the coder: the
`authorization_code` flow with `actor=app`, and the `client_credentials` grant.
Run on 2026-11-03 against the `scriptorium` dev workspace, with
[`spikes/AGE-15-webhook-capture`](../AGE-15-webhook-capture/) running behind
the coder's tunnel to catch webhooks and the OAuth callback.

`grants.mjs` mints a `client_credentials` token into
`data/oauth/client-credentials-token.json` and runs `viewer` with any stored
token. It never prints a token.

```bash
node --env-file=credentials/coder/linear.env spikes/AGE-16-install-grants/grants.mjs client-credentials
node spikes/AGE-16-install-grants/grants.mjs viewer [tokenFile]
```

To see whether a `client_credentials` token can post thoughts, start the capture
service with
`THOUGHT_TOKEN_FILE=/data/oauth/client-credentials-token.json`. No session ever
reached it, so this went untested.

## Results

| | `authorization_code`, `actor=app` | `client_credentials` |
| -- | -- | -- |
| Token | 24 h (`expires_in: 86399`) plus a refresh token | 30 days (`expires_in: 2591999`), no refresh token |
| Granted scope | `app:assignable app:mentionable read write` | `app:assignable app:mentionable read write` |
| `viewer` | `coder`, `app: true` | `coder`, `app: true`, the same id |
| `organization` | Resolves | Failed right after the mint ("Entity not found: Organization"), resolved about 30 s later |
| `teams` | `AGE` only | None |
| Mentionable | Yes | No: not in the @-mention menu |
| Assignable (delegate) | Yes | No: not in the delegate picker |
| Agent session webhook | Arrives (`created` on delegation and mention, `prompted`, stop; see AGE-15) | None arrived; nothing could be delegated or mentioned |

**App user ID for the workspace:** `viewer.id` =
`e067e6e9-6080-4b37-8a80-779f63de574d` (organization
`724adc74-61a9-4c01-8584-2a37b85f3118`). It stayed the same through three
revokes, two `client_credentials` installs and a reinstall, so it belongs to the
app in this workspace, not to one install.

**Team access:** both workspace teams (`AGE`, `SCR`) are public. Linear's
docs say a `client_credentials` token reaches "all public teams", but neither
grant got all of them. The auth-code install sees only `AGE`, and the
`client_credentials` install sees none. Team access looks like it comes from
the install itself, which `client_credentials` skips. The app's "manage" page
has no setting to add a team afterwards.

**Decision:** `authorization_code` with `actor=app`. `client_credentials` gives a
bot that cannot be mentioned, delegated to or see a team.

## Sequence

1. Ran `viewer` with the AGE-15 auth-code token: the app user above.
2. Turned on client credentials for the OAuth app, then revoked the coder in
   workspace settings. The auth-code token started returning 401. No
   `OAuthApp` webhook arrived.
3. Minted a `client_credentials` token: HTTP 200. It saw no organization and no
   teams, and coder was in neither the @-menu nor the delegate picker.
4. Opened the auth-code authorize URL, which said Coder was already
   installed. Revoked it from the app's "manage" page: the `client_credentials`
   token went to 401, and an `OAuthApp` / `revoked` webhook arrived.
5. With the uninstall confirmed, minted a `client_credentials` token again. The
   authorize URL again said Coder was already installed. **Minting a
   `client_credentials` token installs the app**, but as a bot with no team.
6. Revoked from the manage page again (no `OAuthApp` webhook this time), then
   approved the authorize URL. The callback exchanged the code (HTTP 200), the
   new token sees team `AGE`, and the `client_credentials` token is dead.
7. Turned client credentials off on the OAuth app again. A delegation and a
   mention each produced `AgentSessionEvent` / `created`, and the capture
   service posted its thought with the new token.

## Notes for the bridge (AGE-19)

- **Never mint a `client_credentials` token** in the bridge or in setup
  scripts. It installs a teamless bot, and the real install URL then reports
  "already installed" until someone revokes it by hand.
- **Don't rely on the `OAuthApp` / `revoked` webhook.** Only one of three
  revokes sent it. Treat a 401 from Linear as the revoke signal: drop the token
  and wait for a new install.
- **Refresh before the 24 h expiry.** Only `authorization_code` returns a refresh token.
