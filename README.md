# Agent Bridge

## Quickstart

This gets one bot role, `coder`, running on your machine in Docker. At the end
it is reachable from Linear and installed in your workspace, ready to test.

Each role is its own Compose project, with its own Cloudflare Tunnel, Linear
OAuth app and GitHub App. The steps below set up `coder`. For another role,
swap the name throughout.

### What you need

- Docker with Compose v2.
- A Claude Pro or Max subscription and the `claude` CLI.
- A domain on Cloudflare, for the tunnel's public hostname.
- Admin access to a Linear workspace.
- A GitHub account or organisation that can own a GitHub App.
- Node.js 22.12 or later, only to run the tests.

Secrets live in `.env.shared` and `credentials/<role>/`. Git and the Docker
build context both ignore them. Copy each `*.example.env` and fill it in, and
never commit the copy.

### 1. Claude token

Run `claude setup-token`, sign in with the subscription, and copy the token it
prints. It lasts a year.

```bash
cp .env.shared.example .env.shared
```

Set `CLAUDE_CODE_OAUTH_TOKEN` in `.env.shared`. Don't set
`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` anywhere. Either one would bill
the API, and the bridge refuses to start if it finds one.

### 2. Cloudflare Tunnel

The bridge publishes no port on the host. Linear reaches it only through the
role's tunnel.

1. In the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels** and
   create a **Cloudflared** tunnel, for example `coder`.
2. Copy the tunnel token from the install command Cloudflare shows. You don't
   need to install anything, because Compose runs `cloudflared`.
3. Add a public hostname, such as `coder.agents.example.com`, with service
   type `HTTP` and URL `bridge:3000`.

```bash
cp credentials/coder/tunnel.example.env credentials/coder/tunnel.env
```

Set `TUNNEL_TOKEN` in `credentials/coder/tunnel.env`. From here on,
`PUBLIC_URL` means `https://` plus that hostname, with no trailing slash.

### 3. Linear OAuth app

1. In Linear, go to **Settings → API → Applications** and create a new
   application, named after the role (`coder`). That name is how it appears
   in the @-mention menu and the delegate picker.
2. Set the callback URL to `<PUBLIC_URL>/oauth/callback`.
3. Turn on webhooks:
   - URL: `<PUBLIC_URL>/webhooks/linear`.
   - Events: **Agent session events** and **App user notifications**.
4. Leave **client credentials** off. Minting a `client_credentials` token
   installs a bot that can't be mentioned or delegated to, and it blocks the
   real install until someone revokes it by hand. See
   [`spikes/AGE-16-install-grants`](spikes/AGE-16-install-grants/README.md)
   for why.
5. Copy the client ID, the client secret and the webhook signing secret.

```bash
cp credentials/coder/linear.example.env credentials/coder/linear.env
```

Fill in `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`
and `PUBLIC_URL`.

### 4. GitHub App

The bridge doesn't call GitHub yet; that work is AGE-34. Compose still needs
the files below to exist. To get running sooner, leave `github.env` empty and
create a placeholder key:

```bash
cp credentials/coder/github.example.env credentials/coder/github.env
touch credentials/coder/github-app.pem
```

To set up the app now:

1. Go to **GitHub → Settings → Developer settings → GitHub Apps** and create
   a new app, for example `coder`. Turn off the webhook. Give it these
   repository permissions:
   - **Contents:** Read and write.
   - **Pull requests:** Read and write.
   - **Metadata:** Read-only.
2. Generate a private key. Save it as `credentials/coder/github-app.pem`.
   Compose mounts it at `/run/secrets/github_app_key`.
3. Install the app on the repositories the coder may work on. The number at
   the end of the installation's settings URL is the installation ID.
4. In `credentials/coder/github.env`, set:
   - `GITHUB_APP_ID`, from the app's settings page;
   - `GITHUB_INSTALLATION_ID`, from step 3;
   - `GITHUB_APP_SLUG`, the app's URL name. Commits will be authored as
     `<slug>[bot]`.

### 5. Start the stack

```bash
ROLE=coder docker compose -p coder up -d --build
```

The tunnel waits until the bridge's health check passes. Check that both are
up and that the bridge is reachable from outside:

```bash
ROLE=coder docker compose -p coder ps
```

```bash
curl https://coder.agents.example.com/healthz
```

`curl` should print `ok`. If the bridge exits straight away, its log lists
every missing or invalid setting at once:

```bash
ROLE=coder docker compose -p coder logs bridge
```

### 6. Install the coder in Linear

Open `<PUBLIC_URL>/oauth/install` in a browser signed in to the workspace,
and approve. The page should say the coder is installed.

The tokens are kept on the `coder_data` volume and refreshed automatically.
After a restart, the bridge logs `found the Linear install`. If it logs
`not installed in Linear yet`, open the install URL again.

### 7. Test it

Leave the log open:

```bash
ROLE=coder docker compose -p coder logs -f bridge
```

Then, in Linear:

- delegate an issue to `coder`;
- @mention `coder` in a comment;
- reply in the session that opens.

Each of these sends a webhook. The bridge logs `answered a webhook` for each
one, with its `status` and how long the answer took (`ackMs`). A delivery
Linear sends again is logged as `ignored a duplicate webhook`.
`rejected a webhook` means `LINEAR_WEBHOOK_SECRET` doesn't match the app's
signing secret. It can also mean the host clock is more than 60 s off, since
the bridge rejects deliveries signed longer ago than that.

To run the unit tests:

```bash
cd bridge && npm ci && npm test
```

### Rebuild, stop and reset

After changing the code, rebuild and restart with the same `up` command as
step 5. The tunnel keeps running.

```bash
ROLE=coder docker compose -p coder down
```

`down -v` also deletes the `coder_data` and `coder_work` volumes, which hold
the Linear tokens, Claude transcripts and repository clones. After that, you
need to repeat step 6.
