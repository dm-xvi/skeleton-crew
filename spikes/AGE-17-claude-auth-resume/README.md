# Claude subscription auth and session resume ([AGE-17](https://linear.app/scriptorium/issue/AGE-17), throwaway)

Runs one Agent SDK `query()` per `docker compose run --rm`, so every turn gets a
fresh container. The image is `node:24-slim` with
`@anthropic-ai/claude-agent-sdk@0.3.317`, installed inside the image so npm
picks the `linux-x64` Claude Code binary (`2.1.317`). It runs as the `node`
user (uid 1000).

Only `credentials/coder/claude.env` reaches the container: a
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, with no API key (see
[`claude.example.env`](../../credentials/coder/claude.example.env)).
`CLAUDE_CONFIG_DIR` is `/data/claude`, bind-mounted from `data/claude/`,
so transcripts outlive the container. The cwd is fixed at `/workspace`.

`spike.mjs` prints whether each credential variable is set (never the value),
the `init` message's `apiKeySource`, `model` and `session_id`, the reply, the
`result`, and every transcript with its line count and mtime before and after
the query. Queries run with `tools: []`, `maxTurns: 1` and `settingSources: []`.

```bash
docker compose -f spikes/AGE-17-claude-auth-resume/compose.yaml build
docker compose -f spikes/AGE-17-claude-auth-resume/compose.yaml run --rm claude ask "Reply with exactly: pong"
docker compose -f spikes/AGE-17-claude-auth-resume/compose.yaml run --rm claude ask --session-id <uuid> "<prompt>"
docker compose -f spikes/AGE-17-claude-auth-resume/compose.yaml run --rm claude ask --resume <uuid> [--fork --session-id <new uuid>] "<prompt>"
docker compose -f spikes/AGE-17-claude-auth-resume/compose.yaml down
```

Run on 2026-11-03.

## Results

**Subscription auth works.** With only `CLAUDE_CODE_OAUTH_TOKEN` set
(`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` unset),
"Reply with exactly: pong" answered `pong`, `is_error: false`, on
`claude-sonnet-5-5`.

As a control, the same query with no credentials at all returned
`Not logged in · Please run /login`. That came back as a `result` with
`subtype: "success"` but `is_error: true`, and the SDK then threw. Both runs
report `apiKeySource: "none"`, so `apiKeySource` cannot tell a working
subscription token from no auth. Only a real answer proves it.

**`sessionId` writes a transcript, and `resume` survives a restart.** Turn 1
with `sessionId: 11111111-1111-4111-8111-111111111111` and a random codeword
wrote `data/claude/projects/-workspace/11111111-….jsonl` (17 lines) on the host.
After `docker compose down` (no containers left), a new container with
`resume` set to that ID answered the codeword and appended to the same file
(17 → 25 lines). `init.session_id` stayed the same ID.

**`sessionId` naming an existing transcript:**

| Case | Options | Outcome | Transcript |
| -- | -- | -- | -- |
| a | `sessionId` = existing, same cwd | CLI exits 1, and the SDK throws `Claude Code process exited with code 1. stderr: Error: Session ID … is already in use.` No `init` or `result` message is emitted. | Unchanged (byte-identical) |
| a2 | `sessionId` = existing, other cwd (`/workspace/other`) | **Accepted.** It starts a new, empty conversation under the same ID and answers `unknown`. | New `projects/-workspace-other/1111….jsonl`; the original is untouched |
| b | `sessionId` and `resume`, same ID, no fork | CLI exits 1: `--session-id can only be used with --continue or --resume if --fork-session is also specified.` | Unchanged |
| c | `resume` = existing, `forkSession: true`, `sessionId` = new ID | Works: it remembers the codeword, and `session_id` is the new ID | New `2222….jsonl` (22 lines); the original stays at 25 |

**`resume` is scoped to the cwd too:**

| Case | Options | Outcome |
| -- | -- | -- |
| d | `resume` = an ID with no transcript anywhere | `result` with `subtype: "error_during_execution"`, `errors: ["No conversation found with session ID: …"]`; the SDK throws |
| e | `resume` = existing ID, from a cwd with no transcript (`/workspace/third`) | Same as d. It does not look in other project directories. |

So the "already in use" guard is a file check in
`projects/<sanitised cwd>/`, not a global one. An ID is only unique per cwd.

## Notes for the bridge (AGE-18/19)

- **Pass only `CLAUDE_CODE_OAUTH_TOKEN`.** Leave `ANTHROPIC_API_KEY` out of the
  container entirely. To check auth at startup, send a real query; don't trust
  `apiKeySource`.
- **Check `is_error`, not `subtype`.** A logged-out CLI returns
  `subtype: "success"` with `is_error: true`.
- **Keep `CLAUDE_CONFIG_DIR` on a volume, and keep the cwd stable per
  session.** `resume` only finds a transcript under the cwd it was written
  from. If the per-issue worktree path ever changes, the session is lost.
- **First turn: `sessionId`. Later turns: `resume`.** Never both without
  `forkSession`. A first turn that hits "already in use" means a transcript
  exists, so switch to `resume`.
- **Expect two error shapes:**
  - A process exit (code 1, message only in stderr) for bad flags or an ID
    clash.
  - An `error_during_execution` result for a missing transcript.
- **Set `model` explicitly.** The default with this subscription token was
  `claude-sonnet-5-5`.
- **Watch `cleanupPeriodDays`.** The CLI sweeps old local transcripts by that
  setting, so a long-idle issue can lose its session unless the bridge raises
  it.
