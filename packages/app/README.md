# towles-tool-app

Bridges Claude Code to the towles-tool desktop app (`tt-app`) — the MCP tools it
exposes and one hook that keeps its PR view fresh.

## MCP server

Points at the desktop app's own MCP server (`crates/tt-mcp`, served over
loopback HTTP by `tt-app`), so any session with this plugin enabled gets these
tools without manual `claude mcp add` setup:

- **Board** — `task_list`, `task_status`, `task_diff` (reads), `task_create`, `task_summary`,
  `task_sync`, `task_start`, `task_delete` and `task_done` (writes). `task_create` adds a board card only; `task_start` is
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
  worktree stay the user's call. `task_sync` records the branch a task's
  worktree is on now — call it after a `git switch -c` inside the task, so the
  card and PR auto-linking follow the new branch. `task_diff` lists what every
  other open task has changed since it forked from its base; pass your checkout
  as `dir` and it narrows to your repo and adds `overlap`, the files you and
  that task both touched — worth a look before a rebase or a shared refactor.
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
- **Attention** — `needs_you`. Everything the queue has on the user — an agent
  asking, errored or finished unseen, red CI, changes asked, a PR to land — in
  queue order, each with the chip's own words (`why`: "asking", "CI red", "PR
  approved"), the caller's own terminal left out.
  And `summon`, the other direction: chime until the user types into your
  terminal, for when you need them to do something only they can.
- **Calendar** — `calendar_today`, `calendar_next` (reads) and `calendar_set`
  (writes). These exist for *focus protection* — how long until the next
  meeting, how much uninterrupted time is left — not calendar management.
- **The mod's own** — `inbox_take`, `inbox_ack`, `next_prompt`,
  `next_prompt_taken`, `clip_suggest` and `clip_copied` serve the mod below. The
  mod denies the model any call to them, so an agent never reads another's notes
  or spends a suggestion budget.

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
"url": "http://127.0.0.1:${TT_MCP_PORT:-47870}/mcp",
"headers": { "X-TT-Session": "${TT_SESSION_ID:-}" }
```

`TT_MCP_PORT` is the app instance's own port — a `${tt:port 47870-48069}` claim in
its rendered `.env`, stamped onto every terminal it spawns. So a session in a
worktree task's terminal reaches *that* task's app and board, not whichever
instance started first. Outside an app terminal it's unset and the `:-47870`
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

## Commands

- **`/towles-tool-app:done`**: run once you've confirmed the work. It runs
  `/tt:prm` (open and merge the PR, admin merge allowed), then calls
  `task_done`, which finds the task from the checkout, refuses while a PR is
  open or work is unlanded or uncommitted, stops the task's own dev server,
  writes the summary and deletes the worktree and pane. Outside a task it lands
  the work and reports there was no task to delete. Needs the `tt` plugin.

## Mod: the app inside Claude Code

`hooks/register.tsx` is a Claude Code mod (a function-hooks module, named under
`modules` in `hooks/hooks.json`). It carries the app's view of the session, and
the user's words from the app, into Claude Code itself.

### The band above the prompt

```
✦ tt  #7 Claude mods (doing)  PR #42 open · checks passing  ready for /done  4m to Standup  n: next prompt
```

- **Task.** This is the open board task whose worktree holds the session's cwd,
  so a session in a `tt task` checkout sees its own card. If worktrees are
  nested, the deepest match wins.
- **PR.** The task's open PR, or else its latest, with check state. When
  its checks settle to passing or failing, a toast says so once.
- **Ready for /done.** Shown when that PR is open with passing checks: what
  `/towles-tool-app:done` needs to land it.
- **Next meeting.** Time until the next meeting, the only calendar fact the app
  surfaces. It turns yellow inside 15 minutes, and a toast fires once per
  meeting at 5 minutes.

### The pane on the right

In a terminal 144 columns or wider, the mod docks a **tt** pane beside the
transcript, full height: the task, its PR and the next meeting, then each copy
offer as a `copy` badge followed by the exact string it copies. While the pane shows,
the band drops those facts and keeps only its keys (`n`, the digits, `a`): a
pane's hotkeys need the pane focused, the band's work from the empty prompt.
Narrower, the pane waits unplaced and the band carries everything as above.
`/tt` opens it at any width; once you close it, only `/tt` brings it back that
session. Claude Code has no render site under its status line.

The same facts go on the status line too, in short form
(`tt #7 · PR #42 passing · ready for /done · 4m to Standup`),
alongside the band.

The data comes from this plugin's own MCP server (`task_list`,
`calendar_next`) via `$.mcp.call`. It refreshes at session
start, after every turn, and every 60s. App closed means MCP down, so the
band and status line hide instead of showing stale state.

### Notes from the app

A note sent from the app (a session row's **Note to agent…**, `Mod+Shift+M`, or
annotated feedback from the Preview or Chrome pane) reaches the agent without
being typed into its terminal. The mod polls `inbox_take` every 3 s and after
each model step:

- **While the agent works**, the note joins the conversation as a user row the
  model reads at its *next step*. A note that lands during the turn's last step
  has no next step to read it, so it goes again as a prompt when the turn ends.
- **While it is idle**, the note is submitted as your own prompt.

Either way a dim transcript line says so, and `inbox_ack` tells the app, which
marks the session answered as typing into it would. A session without this mod
cannot take a note; the app says so rather than type into its prompt box.

### `/park` and `/next`

- **`/park [idea]`** files the idea (or, with no argument, the text you
  selected) as a backlog task on this checkout's board, through `task_create`.
  The session never leaves what it is doing.
- **`/next`**, or `n` on the band, asks what you will type next: one
  `claude -p` call with no tools, MCP, settings or CLAUDE.md, given the last
  turn's tools and commands, its answer, the task's goal and the prompts you
  typed after similar turns. The answer is shown as the dim suggestion, Tab to
  take. It never runs on its own, and the app holds it to a daily budget
  (Settings → Agent Board → Next-prompt suggestion).

### Copy suggestions

When a turn ends with an answer, the mod sends its last message to
`clip_suggest`. If it holds a code span, link, path or `#123` ref, the app asks
one bare `claude -p` which exact strings you would copy, and keeps only those
that appear verbatim in the message, at most three. The band then offers each as a
`copy` badge and the text itself (cut at 40 characters; the pane shows it whole):

```
✦ tt  …  n: next prompt  1:  copy  https://x.dev/pr/9  2:  copy  bun run e2e  a: copy all
```

A digit in the empty prompt (or a click) copies that one; `a`, with the band
focused, copies all of them in order, apart enough that a clipboard manager
keeps each entry. The offer clears when the next turn starts. It is on by
default, held to its own daily budget, and its question is editable
(Settings → Agent Board → Copy suggestions). Each copy is recorded through
`clip_copied` as a `clip_suggest.copied` event.

The `$.state` contract is `types/index.d.ts`, and the pure logic in
`hooks/band.ts`, `hooks/clip.ts`, `hooks/inbox.ts`, `hooks/park.ts` and `hooks/suggest.ts` is
what `tests/` covers:

```sh
claude plugin validate packages/app
claude plugin test packages/app
```

## Hooks

| Hook                            | Event                | Does…                                                                 |
| -------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `hooks/scripts/gh-pr-nudge.sh`  | `PostToolUse` (Bash)  | After a `gh pr` mutation (merge/create/close/reopen/ready) or a `gh issue` mutation (create/close/reopen), nudges a running `tt-app` instance to refresh the matching data immediately instead of waiting for its normal poll interval (`tt task nudge prs`/`tt task nudge issues`). |

The hook is a no-op unless the session looks towles-tool-relevant — either it's
running inside a terminal the app itself spawned (`TT_SESSION_ID`/
`TT_APP_INSTANCE` set), or its working directory is inside a checkout on the
Agent Board (a tracked repo, or any worktree under one). That test is
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

In Claude Code 2.1.275 or later, one step:

```text
/plugin install towles-tool-app --marketplace ChrisTowles/towles-tool
```

Or from a shell:

```bash
claude plugin marketplace add ChrisTowles/towles-tool
claude plugin enable towles-tool-app@towles-tool
```
