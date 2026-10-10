# Slack agents

Personal, persistent Claude Code agents Chris talks to in his own Slack: a
single-user take on Claude Tag (which is Team/Enterprise only), built on the
`claude` CLI and Max login already on this machine. The ideas come from
open-tag; the trust model doesn't.

## Using it

Write to the agents' conversation (your Slack DM with yourself unless
`agents.conversation` names another channel id):

- `@atlas what's left on the packing list?` or `atlas: …` starts a thread
  with `atlas`.
- Any reply in that thread goes back to `atlas`, no prefix needed. An
  explicit `@scout` in the thread hands that one message to `scout`.
- A message gets ⏳ while its turn runs and 👀 while it's queued behind a
  running turn. The reply arrives as `*atlas* · …` in the thread, posted with
  your own token. A failure replies `*atlas* · ⚠️ <reason>`, never silence.
- "Remind me tomorrow at 9…" makes the agent set a reminder. The reply shows
  `⏰ back here <time>`, and at that time the agent takes a turn in the same
  thread with its note.

Three quick messages are one turn: a burst dispatches after `quietMs` of quiet
or `capMs` after its first message.

## Setup

Needs the Slack collector's tokens (`collectors.slack.token`, a user `xoxp`
token with `chat:write`, `im:history`, `reactions:write`, and `appToken` for
Socket Mode, subscribed to user `message.im`). The DM watcher itself may stay
off. Then in `towles-tool.settings.json`:

```json
"agents": {
  "enabled": true,
  "roster": [
    { "name": "atlas", "description": "General helper" },
    { "name": "scout", "description": "Reads my repos", "model": "sonnet",
      "dirs": ["~/code/p/toolbox"], "tools": ["Bash"],
      "allow": ["Bash(git log:*)", "Bash(git status)"] }
  ]
}
```

Other keys: `conversation` (default `""` = self-DM), `quietMs` (800), `capMs`
(5000), `turnTimeoutMinutes` (20), and `prompt`, the appended system prompt
with `{name}`, `{description}` and `{stateDir}` placeholders. Edits apply on
the next message, with no restart.

## Trust model

- **Only your messages wake an agent.** The sender must be the token's own
  user (`auth.test`). Nobody else's text ever reaches a prompt, and no thread
  history is fetched, so the agent sees only what you sent it.
- **Every turn is `claude -p --restricted`**, never
  `--dangerously-skip-permissions`: user, project and local settings files
  are ignored; file tools are confined to the agent's folder plus its `dirs`;
  `--permission-prompts none` denies anything that would prompt; and
  `--strict-mcp-config` loads no MCP servers. Tools are pinned to Read, Edit,
  Write, Glob, Grep and WebSearch plus the agent's `tools`. Bash is available
  only when named, and then only the commands its `allow` rules permit.
- **A cleared environment.** The process gets `HOME PATH USER LANG LC_ALL TERM
  TMPDIR` and nothing else. Your message goes in on stdin, so it never lands
  in argv, `ps` or the spawn log.
- **One way out.** A turn answers with JSON (`reply`, optional `remind`), the
  same question-and-JSON-answer shape as every other prompt in this repo
  (`tt_exec::claude`). Only `reply` reaches Slack, and only in the thread that
  asked.
- **Audit.** Every turn is a row in `agent_turns`: outcome, cost, and which
  tools the floor refused.

## Where things live

- Logic: `crates/tt-agents` (routing, debounce, argv, prompts, reply parsing,
  `execute`). The I/O shell is `crates-tauri/tt-app/src/agents.rs`, fed by the
  Slack socket (`slack_socket.rs`), so only the instance holding the socket's
  singleton lock answers.
- Agent folders: `tt_config::agents_dir()/<name>/` (`MEMORY.md`, `notes/`),
  shared across checkouts. `--restricted` skips `CLAUDE.md`, so the app sends
  `MEMORY.md` in the turn prompt whenever it changed since the session last
  saw it.
- tt.db (v21): `agent_sessions`, `agent_threads`, `agent_posts` (echo guard;
  agents post as you), `agent_reminders`, `agent_turns`.

## Known gaps

- One `claude -p --resume` per batch, not a long-lived stream-json process, so
  a message sent mid-turn waits for the next turn rather than reaching the
  agent while it works.
- After Claude Code compacts a long session, `MEMORY.md` isn't re-sent until
  it changes.
- Agent state follows whichever instance holds the Slack socket lock.
