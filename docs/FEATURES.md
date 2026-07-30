# Features: in towles-tool, not yet in Claude Desktop

What this app does that Claude Desktop doesn't. Summarised in the
[README](../README.md).

Checked on 2026-07-19 against Claude Desktop **1.22209.0** (built 2026-07-16),
using the published [docs](https://code.claude.com/docs/en/desktop) plus the
installed bundle. Biggest gap first. Read the overlap list under it too: most
of what this repo does, Desktop now does as well.

- **Handing work to an agent is one gesture.** The Agentboard `+` takes a
  half-formed thought, a pasted screenshot, and `#` to attach one of the repo's
  open issues so the goal points at what it's for. Submit it as typed, or press
  a prompt improver first — Direct, Plan and Brainstorm ship as defaults, each
  an instruction you can edit — and claude rewrites the goal with the repo and
  the image in view, proposing the title and branch. That lands in the fields,
  editable, with Undo. Submitting mints the worktree, renders its `.env`, runs
  the repo's setup and starts Claude on that goal, all before you look away.
  From then on the rail is the monitor: agent state, which model is running it
  (Fable or Sonnet), uncommitted diff, linked PR. Teardown is the same gesture
  in reverse, and it refuses while the task still holds work only it can prove.

  ![The Agentboard + flow: a rough goal plus a pasted screenshot, an optional prompt improver rewriting it on target and naming the branch, the worktree minted with Claude already working in it, and a guarded teardown that refuses before it destroys](docs/images/demos/agentboard.gif)

- **A file editor Claude Code can see into.** `tt-ide` makes the app an IDE-protocol server, so the Monaco editor in the Files pane is wired to the Claude Code session running in that folder's terminal. Highlight lines and the selection streams live into the session — the editor shows `L17-18 live to claude`, the CLI shows `2 lines selected` — and `@ send` turns it into an `@file#L17-18` reference in the prompt. Editing and saving go the same way. Desktop only takes context from its own panes, via spot edits, "Attach as context", and `@`-mention autocomplete; it cannot see a selection in an editor beside it.

  ![Selecting lines in the app's Monaco editor, the selection streaming live into the Claude Code session beside it, sending it as an @file#L17-18 mention, and Claude answering against exactly those lines](docs/images/demos/file-editor.gif)

  The same pane also bridges rust-analyzer over Tauri IPC for hover and
  completions on Rust source, and a `path:line` link printed in a terminal
  opens the file at that line. That LSP bridge is still a spike — it reports
  `starting`/`ready`/`failed` in a chip, which is there to decide whether it
  earns its keep.

- **Cross-repo work board.** Board is a kanban of tasks spanning every watched
  repo. Each task links 0..N issues, 0..N PRs, and usually a worktree,
  and done rolls up from GitHub PR state. Desktop has nothing like it. Its
  "tasks pane" holds background subagents inside a single session, and no
  cross-repo surface exists.

  ![The Board kanban across three repos, filtering across them, then a merged PR attaching to a task and rolling it to done](docs/images/demos/board.gif)

- **Always-on local event log.** Every subprocess and user action lands as
  JSONL at `<data_dir>/telemetry/events-<date>.jsonl`, rotated daily, tagged
  with `tt.task`, queryable with `jq`, and never sent anywhere. Desktop's
  OpenTelemetry surface is more configurable than this repo's, but it exports
  to a collector you run. I found no sign of an on-disk log that is on by
  default, though I read strings in the bundle rather than watching it run.

  ![The Telemetry screen: today's records, filtered down to process.spawn spans, then one record opened to its full JSON including tt.task](docs/images/demos/telemetry.gif)

- **Guarded task lifecycle.** `tt task new` in, `tt task rm`/`clean` out, with
  a setup hook, a port lifecycle and a removal guard hung off either end (the
  whole cycle is under [Worktree tasks](#worktree-tasks)). Desktop creates
  worktrees and auto-archives them on PR merge or close, but has none of those
  three — in particular no removal guard for a branch that never had a PR.

  ![Diagram: tt task new creating a worktree, rendering its .env, running TT_TASK_SETUP and starting the agent; then tt task rm checking for unlanded work before teardown](docs/images/demos/lifecycle.gif)

- **Per-task port isolation.** Both tools put worktrees in
  `.claude/worktrees/`. The difference is the `${tt:port A-B}` claim: every
  task renders its own `.env`, so ten tasks run ten dev servers without
  colliding. Desktop's `.worktreeinclude` copies gitignored files verbatim,
  which hands every worktree the same port.

  ![Diagram: three worktrees copying one .env all collide on port 3000, while a ${tt:port} pool claim renders each its own port](docs/images/demos/ports.gif)

- **Squash-merge-aware landing detection.** The guard above rests on it: only
  the branch's cumulative diff against base can prove a squash merge landed.
  Desktop auto-archives a worktree once its PR merges or closes, which covers
  the common case but never has to answer whether a branch with no PR still
  holds work.

  ![Diagram: after a squash merge, reachability, SHA lookup and per-commit patch identity all report unmerged; only the cumulative diff against base proves the work landed](docs/images/demos/landed.gif)

### Overlap: things Desktop already does

Written down so this repo stops claiming them. Desktop ships automatic git
worktrees at the same `.claude/worktrees/` path with auto-archive on PR merge,
a real `node-pty` terminal, a file pane with editing and save-conflict
detection, file-by-file diff review with batched per-line comments, PR CI
monitoring with auto-fix and auto-merge, GUI plugin and MCP management,
scheduled tasks, and a browser pane with element selection. On PR automation
and telemetry configurability it is ahead of this repo.

What Desktop lacks is a shorter list than it first appears. It runs
interactive only, with no `--print` and no headless entry point, so there is no
equivalent of `tt collect`. The Linux beta also has no
Computer Use, no dictation, and no self-update.
