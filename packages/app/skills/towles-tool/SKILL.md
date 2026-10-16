---
name: towles-tool
description: Use towles-tool (`tt`) CLI for journaling and worktrees. Use when asked about "tt commands", "daily notes", "meeting notes", or worktree management.
user_invocable: true
---

# towles-tool CLI

Personal CLI toolkit. Binary: `tt`

Config: `~/.config/towles-tool/towles-tool.settings.json`

## Journaling

```bash
tt journal daily-notes  # Weekly file, daily sections (alias: tt today)
tt journal meeting      # Meeting notes
tt journal note         # General notes
tt journal jot "text"   # Append a timestamped bullet to today's note
tt journal list         # Recent entries
tt journal search TEXT  # Search entries
```

## Open a path in the app

```bash
tt open src/main.rs        # reveal it in the app's Files pane, in *this* task
tt open src/main.rs:42     # …scrolled to line 42 (`--line 42` also works)
tt open crates/tt-git      # a folder opens the pane on that checkout
```

Shows the path in the running app's Files pane, beside the terminal you typed it
in — routed by the `TT_SESSION_ID` the app stamps on its terminals, so it lands
in this task's window and not another's. From a terminal the app didn't spawn
there's no session to route on and it falls back to the checkout the path is in.

Fails (non-zero), rather than opening anything else, when: the path doesn't
exist, it's under no git repository (the pane browses a checkout), or no app
instance is serving this checkout — there is no `preferredEditor` fallback.
`preferredEditor` still applies to the journal commands above.

## Worktree tasks

```bash
tt task init               # Onboard a repo: template, gitignore .env, primary .env
tt task new "Do the thing" --repo myrepo -b feat/thing  # board task + branch-named worktree + rendered .env
tt task new "Do the thing" --repo myrepo --goal "..."   # goal shown on the Board card under the title
tt task new "Do the thing" --repo myrepo --status doing # Board column: backlog (default), doing or done — anything else is refused before a worktree is made
tt task new --pr 123 --repo myrepo                     # review task: checks out PR #123's existing head branch (fork PRs as <owner>/<branch>)
tt task new --issue 42 --repo myrepo                   # task for open issue #42 on feat/42-<slug>, titled after it, issue attached to the Board row (TITLE/-b override)
tt task ls                 # Fleet: main checkout + tasks, branch, dirty, ports
tt task env <name>         # (Re)render a checkout's .env (or `primary`) — idempotent, keeps claims
tt task ports              # Repo's port picture: every checkout's claims + registry, each probed (`--probe <port>` for one)
tt task sync [<name>]      # Record the branch a task's worktree is on now (default: cwd's task); a worktree with no Board row gets one
tt task rm <name>          # Guarded removal; deletes the branch too when its work landed (or it has none)
tt task clean              # Remove every merged/gone task, then delete landed branches no worktree holds
tt task nudge <prs|issues|slack:dm>  # Refresh that collector now instead of on the app's next poll
```

"Landed" is proven from content (merged, rebase-merged, squash-merged) or, when a
PR was fixed up or rebased before merging, `PR merged`: a merged PR's head — current
or one a force-push replaced — reaches the local tip. Commits added after that merge
still read as unlanded.

More flags:

- `new`: `-b`/`--branch` names the branch (default: slugged title), `--base <REF>`
  the ref it branches from (default: the main checkout's branch), `--notes` free-form
  context stored on the Board row, `--json` prints the created task.
- `ls --stale [DAYS]` keeps only tasks with no unlanded commits in that many days
  (default 7) and adds an AGE column.
- `rm --force` skips the guards (each skip is printed); `rm --outcome done|abandoned`
  sets what the closed Board row records (default: done if the work landed).
- `clean --dry-run` reports what it would remove without touching anything.
- `nudge --trigger <label>` tags the telemetry event only (e.g. `pr:create`).
- Every subcommand except `nudge` takes `--root <DIR>` for a checkout other than the
  one containing cwd; `ls`, `sync`, `ports`, `clean` and `new` take `--json`.

`nudge` is for hooks and scripts, not for you to run by hand — the app polls
these collectors on its own cadence anyway. It routes by `TT_SESSION_ID`, so
it reaches the app instance that opened the terminal it runs in; from a
session started outside the app it reaches every open instance. Add
`--only-if-tracked` and it skips — successfully — unless the terminal is one
the app spawned or the cwd sits under a repo on the rail, which is what keeps
a globally enabled hook from sweeping `gh` for unrelated projects.

Run `sync` (or the MCP `task_sync` tool) after creating or switching branches
inside a task's worktree: the board card records the branch the task was made
with, and PR auto-linking follows the record, not the checkout. The folder
keeps its name. It refuses a detached HEAD and the task's base branch.

Setup output (`TT_TASK_SETUP` or the lockfile install) is kept per task under
the data dir's `task-setup-logs/`; a failed setup prints the log's path, and
the app's failure toast has an Open log button. A render warns when a
`${tt:port A-B}` pool is nearly exhausted — widen the range before tasks fail.

`rm`/`clean` run a task's declared `TT_TASK_TEARDOWN` command (from its
rendered `.env`) against the worktree right before removing it — for
whatever a task's `TT_TASK_SETUP` started that the built-in docker
compose/container sweep can't find on its own (e.g. a compose stack not
named after the task). Unset by default; declare it per-repo in
`.env.example`.
