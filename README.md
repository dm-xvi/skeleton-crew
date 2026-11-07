# Agent Bridge

## Quickstart

Runs the `coder` role in Docker, reachable from Linear through a Cloudflare
Tunnel. You need Docker with Compose v2, a Claude Pro or Max subscription, a
domain on Cloudflare and admin access to a Linear workspace.

Secrets go in `.env.shared` and `credentials/coder/`, which git ignores. Each
file has a committed `*.example.env` (or `.env.shared.example`) to copy.

1. **Claude.** Copy `.env.shared.example` to `.env.shared` and set
   `CLAUDE_CODE_OAUTH_TOKEN` to the output of `claude setup-token`. Don't set
   `ANTHROPIC_API_KEY`: the bridge won't start with it.

2. **Tunnel.** [Create a remotely managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
   and route its public hostname to `http://bridge:3000`. Put its token in
   `credentials/coder/tunnel.env`. `PUBLIC_URL` below is `https://<hostname>`.

3. **Linear.** [Create an OAuth app for an agent](https://linear.app/developers/agents)
   named `coder`, with:
   - callback URL `<PUBLIC_URL>/oauth/callback`;
   - webhook URL `<PUBLIC_URL>/webhooks/linear`, with agent session events
     turned on;
   - client credentials left off.

   Put its client ID, client secret, webhook secret and `PUBLIC_URL` in
   `credentials/coder/linear.env`.

4. **GitHub.** Not used yet, but Compose needs the files:

   ```bash
   cp credentials/coder/github.example.env credentials/coder/github.env
   ```

   ```bash
   touch credentials/coder/github-app.pem
   ```

5. **Start it.**

   ```bash
   ROLE=coder docker compose -p coder up -d --build
   ```

   `https://<hostname>/healthz` should answer `ok`. If not, the bridge log
   lists every bad setting.

6. **Install it.** Open `<PUBLIC_URL>/oauth/install` and approve.

7. **Test it.** Delegate an issue to `coder`, or @mention it, and watch the log:

   ```bash
   ROLE=coder docker compose -p coder logs -f bridge
   ```

   Each delivery logs `answered a webhook`, and a repeat logs `ignored a
   duplicate webhook`. `rejected a webhook` means a wrong webhook secret or a
   clock more than 60 s off. To run the unit tests:

   ```bash
   cd bridge && npm ci && npm test
   ```

Rebuild with the same `up` command. `down -v` deletes the volumes, including
the Linear install.
