# Webhook capture (AGE-15, throwaway)

A zero-dependency Node service behind the coder's Cloudflare Tunnel. It answers
200 to every request and writes method, path, query, headers and the raw body to
`data/webhooks/` (mounted at `/data/webhooks/` in the container). The tunnel
routes the public hostname to `http://bridge:3000`, so the service is called
`bridge`.

`/oauth/callback` is handled separately. The capture goes to `data/oauth/` and
is never a fixture, because it holds the authorization code. The service
exchanges the code for a token, saved to `data/oauth/token.json`, so the app
install completes.

With `EMIT_THOUGHT=1` (the default), the service posts one `thought` activity
when a session is created or prompted. That keeps the session active, so Linear
shows the stop control. The capture of the incoming event is written before the
thought is sent, so the thought never changes a captured payload.

## Run

```bash
docker compose -f spikes/webhook-capture/compose.yaml up -d
docker compose -f spikes/webhook-capture/compose.yaml logs -f bridge
```

## Install the app (actor=app)

Open this URL in a browser signed in to the dev workspace:

```
https://linear.app/oauth/authorize?client_id=<LINEAR_CLIENT_ID>&redirect_uri=<PUBLIC_URL>/oauth/callback&response_type=code&scope=read,write,app:assignable,app:mentionable&actor=app
```

## Events to trigger, in order

1. Delegate an issue to the coder → `created` (delegation).
2. @mention the coder in a comment on a different issue → `created` (mention).
3. Reply in the session from step 1 → `prompted`.
4. Press stop on that session → `prompted` with `agentActivity.signal = "stop"`.

## Stop

```bash
docker compose -f spikes/webhook-capture/compose.yaml down
```
