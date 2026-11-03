# Linear webhook fixtures

Real deliveries from the coder's OAuth app, captured on 2026-11-03 for [AGE-15](https://linear.app/scriptorium/issue/AGE-15)
(P0-3) with [`spikes/AGE-15-webhook-capture`](../../../../spikes/AGE-15-webhook-capture/).
Personal data and secrets were replaced by
[`scrub.mjs`](../../../../spikes/AGE-15-webhook-capture/scrub.mjs), and each body was
re-signed.

| Fixture | Event | How it was triggered |
| -- | -- | -- |
| `agent-session-created-delegation.json` | `AgentSessionEvent` / `created` | Issue delegated to the coder |
| `agent-session-created-mention.json` | `AgentSessionEvent` / `created` | `@coder` in a comment on another issue |
| `agent-session-prompted.json` | `AgentSessionEvent` / `prompted` | Reply in an existing session |
| `agent-session-prompted-stop.json` | `AgentSessionEvent` / `prompted`, `signal: "stop"` | Stop pressed on a session |
| `app-user-notification-issue-assigned-to-you.json` | `AppUserNotification` / `issueAssignedToYou` | Sent with the delegation |
| `app-user-notification-issue-subscribed.json` | `AppUserNotification` / `issueSubscribed` | Sent with the delegation |
| `app-user-notification-issue-comment-mention.json` | `AppUserNotification` / `issueCommentMention` | Sent with the mention |
| `app-user-notification-issue-unassigned-from-you.json` | `AppUserNotification` / `issueUnassignedFromYou` | Issue un-delegated |

## Format

```json
{ "capturedAt": "…", "method": "POST", "path": "/webhooks/linear", "headers": { … }, "body": "<raw request body>" }
```

`body` is the exact request body as a string. Feed it to the verifier as is,
and don't parse it and re-serialise it first. Only the headers Linear sets are kept:
`content-type`, `user-agent`, `linear-delivery`, `linear-event`,
`linear-signature` and `linear-timestamp`.

## Signatures

- `Linear-Signature` is the lowercase hex HMAC-SHA256 of the raw body, keyed
  with the webhook secret. Every original capture verified this way against the
  real secret.
- In these fixtures it is re-computed with the dummy secret
  **`lin_wh_fixture_secret_not_real`**.
- `Linear-Timestamp` equals the body's `webhookTimestamp`, in Unix
  milliseconds. Deliveries arrived 110–410 ms after that timestamp. A verifier
  that enforces freshness has to inject its clock in tests, because these
  timestamps are from 2026-11-03.

## What was learned

- **`agentSession.id` is a UUID v4**, for example
  `846c30a2-2a0d-426e-8169-b103be355c19`. The id was a UUID in all three
  sessions seen. `agentSession.slugId` is a separate 13-character hex slug.
- **Delegation and mention look different in `created`:**
  - On a mention, `agentSession.sourceMetadata` is
    `{ "type": "comment", "agentSessionMetadata": { "sourceCommentId": … } }`
    and `previousComments` is a list. The prompt body is the comment text.
  - On a delegation, both are `null`. Linear opens the thread with a system
    comment ("This thread is for an agent session with coder.") that has no
    `userId`, and the prompt body is "Work on [AGE-n](url)".
- **Only `created` carries `promptContext`, `previousComments` and
  `guidance`.** `promptContext` is an XML-ish `<issue>…</issue><user-request>…`
  block, and `guidance` was `null`. `prompted` carries the new
  `agentActivity` only.
- **Stop is a `prompted` event.** Its `agentActivity.signal` is `"stop"`, its
  `content.body` is `"stop"`, and `agentSession.status` is already
  `"stopping"`.
- **Un-delegating and delegating again creates a new session.** The first
  session's `created` was followed by `issueUnassignedFromYou`, and a later
  delegation of the same issue produced a second session id.
- **Notifications arrive alongside session events**, under a separate
  `Linear-Event: AppUserNotification`. The bridge must accept and ignore them.
- **Install path (input for P0-4).** The `actor=app` authorize URL with scopes
  `read,write,app:assignable,app:mentionable`, followed by an
  `authorization_code` token exchange, returned 200. The response held
  `access_token`, `token_type: "Bearer"`, `expires_in: 86399` (24 h),
  `refresh_token` and `scope: "app:assignable app:mentionable read write"`.
  The token queries `viewer` as an app user (`viewer.app = true`) and can post
  `agentActivityCreate` thoughts.
