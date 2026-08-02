# towles-tool-app

Bridges Claude Code to the towles-tool desktop app (`tt-app`) — the MCP tools it
exposes and one hook that keeps its PR view fresh.

## MCP server

Points at the desktop app's own MCP server (`crates/tt-mcp`, served over
loopback HTTP by `tt-app`), so any session with this plugin enabled gets these
tools without manual `claude mcp add` setup:

- **Board** — `task_list`, `task_status` (reads), `task_create`, `task_summary`,
  `task_start` and
  `task_delete` (writes). `task_create` adds a board card only; `task_start` is
  what turns one into work in progress — it mints the task's git worktree and
  launches a Claude session in it on the task's goal and notes. It answers
  `status: "starting"` because the worktree and agent come up asynchronously in
  the app, so confirm with `task_list` rather than assuming. `task_delete`
  removes the task's panes and git worktree along with its board row, and
  refuses — deleting nothing — when the worktree still holds uncommitted or
  unlanded work. `task_summary` is the last thing an agent finishing a task
  should call: it writes the wrap-up onto the card, which outlives the worktree
  and its terminal scrollback, so the record is still there when the user comes
  to confirm the work. It records only — closing the task and removing the
  worktree stay the user's call.
- **Preview** — `preview_file`. Puts a file you wrote on screen in the
  app's Preview pane, beside the terminal you're running in: the way to hand
  back something worth *looking at* — a plan laid out for a decision, a table of
  what a sweep found, a diagram — rather than as terminal output. Any file works:
  Markdown renders as prose, a self-contained `.html` artifact as the page it is
  (in a sandboxed frame, so inline the CSS/JS and embed images as data: URIs),
  anything else as text. Call it with the absolute path. The pane hot-reloads —
  rewrite the file and what's on screen follows, no second call.
  Write it wherever you like, a scratch dir outside the repo included: the pane
  opens in *your* terminal's task, because the request carries the
  `TT_SESSION_ID` of the shell you're running in (see `.mcp.json` below), not
  because of where the file sits. For a file that already exists rather than
  a page you wrote, use `file_open` instead — same pane routing, but it reveals
  the file in the Files pane (the `tt open` CLI command is the same call). The user can annotate what you showed and send
  it straight back to you.
- **Calendar** — `calendar_today`, `calendar_next` (reads) and `calendar_set`
  (writes). These exist for *focus protection* — how long until the next
  meeting, how much uninterrupted time is left — not calendar management.

The broader dashboard-read tools were pruned in the 2026-07 tool-surface review.

**Requires the app to be running.** There is no headless fallback: the server
lives in `tt-app`, so app closed means MCP down. Every instance serves its own,
on its own port, and a session started in an app terminal reaches the app that
spawned it — so with several worktree tasks open, each one's tools act on that
task's app and its board.

No token: the endpoint is loopback-only and refuses any request carrying an
`Origin` header or a non-JSON `Content-Type`, which is what keeps a web page you
visit from POSTing to it. That is the *whole* guard on writes — there is no
capability gate any more. See the trust-boundary doc in `crates/tt-mcp`.

The checked-in `.mcp.json` never needs editing per checkout, because both the
port and the caller's identity ride the environment:

```json
"url": "http://127.0.0.1:${TT_MCP_PORT:-8787}/mcp",
"headers": { "X-TT-Session": "${TT_SESSION_ID:-}" }
```

`TT_MCP_PORT` is the app instance's own port — a `${tt:port 8787-8986}` claim in
its rendered `.env`, stamped onto every terminal it spawns. So a session in a
worktree task's terminal reaches *that* task's app and board, not whichever
instance started first. Outside an app terminal it's unset and the `:-8787`
default applies. A packaged app in no checkout falls back to `"mcp": {"port": N}`
in the shared settings file.

`TT_SESSION_ID` is stamped by the app on every terminal it spawns, and Claude
Code expands `${VAR:-default}` in `.mcp.json` headers — so each session
identifies its own terminal without the model having to know or pass anything.
`preview_file` and `file_open` route on it. Outside an app terminal the variable is
unset, the header arrives empty, and the tool falls back to matching the file's path
against tracked folders. It is not a credential and grants nothing: request
admission (loopback + no `Origin` + JSON `Content-Type`) is still the whole
guard.

## Skills

- **`task-onboarding`** — walks a repo through adopting tt worktree tasks:
  discover what the repo needs per-task (dev ports, docker names, setup),
  pick `${tt:port A-B}` pools that don't overlap other onboarded repos,
  write the tokenized `.env.example` (or `.claude/task-env.template`
  sidecar), then run the mechanical half with `tt task init` and verify with
  a smoke task. Triggers on "onboard this repo for tasks" / "set up tt
  tasks" / a repo whose tasks render an empty `.env` but need per-task
  ports. (Tasks work without any template — onboarding is only for repos
  that need ports/env vars templated per task.)
- **`towles-tool`** — `tt` CLI reference: journaling and worktree-task
  commands. Triggers on "tt commands", "daily notes", "meeting notes", or
  worktree management.

## Hooks

| Hook                            | Event                | Does…                                                                 |
| -------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `hooks/scripts/gh-pr-nudge.sh`  | `PostToolUse` (Bash)  | After a `gh pr` mutation (merge/create/close/reopen/ready) or a `gh issue` mutation (create/close/reopen), nudges a running `tt-app` instance to refresh the matching data immediately instead of waiting for its normal poll interval (`tt task nudge prs`/`tt task nudge issues`). |

The hook is a no-op unless the session looks towles-tool-relevant — either it's
running inside a terminal the app itself spawned (`TT_SESSION_ID`/
`TT_APP_INSTANCE` set), or its working directory is inside a checkout on the
Agentboard rail (a tracked repo, or any worktree under one). That test is
`tt task nudge --only-if-tracked`'s, not the script's: only `tt` can read the
tracked set, and a shell approximation of it recognised *this* repo alone, so
`gh pr create` in every other checkout was dropped in silence. This plugin is
meant to be enabled globally, so without the test the hook would fire — and
make every open window sweep `gh` — for unrelated projects. A skip lands in the
event log as `hook.nudge` `outcome=not_tracked`. It also does nothing
if no towles-tool app is running; the nudge is picked up on the app's next
start otherwise. When the session *is* relevant and `tt` exists but the nudge
command itself fails (say, an installed `tt` older than this plugin), the hook
reports that to the session instead of staying silent.

## Installation

```bash
claude plugin marketplace add ChrisTowles/towles-tool
claude plugin enable towles-tool-app@towles-tool
```
