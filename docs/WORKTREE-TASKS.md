# Worktree tasks

How this repo's branch-per-worktree tasks work — created and removed with
`tt task`, never raw `git worktree`. The root [CLAUDE.md](../CLAUDE.md) carries
the short version; this is the full convention.

Tasks are branch-named git worktrees nested **inside** the checkout at
`<checkout>/.claude/worktrees/<name>/` — Claude Code's native worktree
location — one per parallel line of work (a `.tt-task` marker file sits at
each task's root). Any plain git checkout is task-capable with no
restructuring: point `tt task new` at it with `--repo`. Tasks are ephemeral:
created for a branch, removed when the branch merges. Manage them with
`tt task` — never raw `git worktree` or new clones. (`git clean -fdx` at the
checkout root is safe — git skips nested repositories without a second `-f`.)

```sh
tt task init                              # onboard a repo: template, .gitignore, primary .env
tt task new "<title>" --repo <name|dir> [-b feat/thing] [--base <ref>] [--status doing] [--notes ...]
                                          # board task + .claude/worktrees/<branch-slug> in one shot
                                          # (branch defaults to a slug of the title)
tt task ls [--json]                       # fleet: main checkout + tasks, branch, dirty, ports
tt task env <name>                        # (re)render .env — idempotent, keeps claims
tt task env primary                       # same, for the main checkout
tt task ports [--probe <port>] [--json]   # repo's port picture: every checkout's claims + registry, each probed for a listener
tt task rm <name> [--force]               # guarded removal + docker cleanup
tt task clean [--dry-run]                 # rm every merged/gone task + sweep stale state
```

**Claude Code's own worktree surfaces are not tasks.** `claude --worktree`,
background agents and the desktop app's parallel sessions make their own
worktrees, and nothing here renders, tracks or removes them — routing them
through `tt task` gave every background agent a marker, ports, an `.env` and a
rail folder nobody asked for. A task is created deliberately: `tt task new`, or
the app's `+`.

The Agentboard rail shows the whole fleet automatically (worktrees of any
tracked checkout are discovered per poll), and the `+` button on the repo
header opens the same creation flow as a modal: goal → branch → base, then
Claude starts on the goal in the new task's terminal. Discovery covers the
main checkout plus the worktrees **a board task is bound to** — the row
`tt task new` and the app's `+` write — and anything else (a Claude Code
agent's worktree, a hand-added one) reaches the rail only when the rail
header's worktree toggle (`agentboard.showUnmanagedWorktrees`) is on.
**Don't reintroduce a filesystem check here.** That's what it used to be, and
it failed whenever a worktree was created through the retired worktree hooks:
those worktrees carried `.tt-task` markers, so `is_managed_task` was true and
the toggle hid nothing (six `agent-<hex>` folders, nothing to be done about
them). The board row records intent; the filesystem can't. The engine is
store-free, so the host pushes the bound set in each scan tick
(`Engine::set_bound_worktree_dirs`) and discovery applies it
(`Engine::expand_with_worktrees`) without touching the git cache.

Rules when working in a task:

- **The main checkout is load-bearing.** Every task's git state lives in its
  `.git` — never delete, move, or re-clone it. Tasks never work on the
  default branch directly (git itself blocks a second checkout of it while
  the main checkout holds it).
- **One branch per task, named after it.**
  `tt task new "Thing" --repo <r> -b feat/thing`
  creates `.claude/worktrees/feat-thing` (the folder is the slugged branch —
  one-way; the branch is always read from git, never parsed back from the
  folder) (`--base` when not branching off the
  default). A task whose PR merged is done — `tt task rm` it (or
  `tt task clean`, which finds every merged/gone task); commits reachable
  from no branch or remote block removal by design.
- **Ports come from the rendered `.env`** — `.env.example` is the template
  (`${tt:port A-B}` pool claims, `${tt:task-name}`, `${tt:var NAME}`; a repo
  without tokens uses the `.claude/task-env.template` sidecar, and a repo
  with neither renders an empty `.env` — no template is required to create
  tasks), and a manual `.env.local` pin overrides it; shell env overrides
  both. Never hardcode a port anywhere. The main checkout claims its ports
  the same way.
- **No setup scripts.** `tt task new` runs the `TT_TASK_SETUP` command
  declared in `.env.example` (spawned directly, no shell — `npm install`
  here), falling back to lockfile detection in repos that don't declare one —
  and, in the CLI, runs it synchronously: `tt task new` is a foreground tool,
  so blocking on the install there is correct. **The app's `+` flow does
  not** — `task_create` (`crates-tauri/tt-app/src/task.rs`) only does the
  fetch/worktree-add/`.env`-render half and returns; `task_run_setup` fires
  separately, after the pane already opened, off `agentboard.tsx`'s
  `createTask`. The pane must never wait on the install again — it's what
  turned a 2–3s Linux task into a 1–2 minute macOS one (npm's per-file cost
  under APFS + Gatekeeper scanning is far higher than on Linux for the same
  `node_modules`), and the fix is to keep the two off the same critical path,
  not to make the install itself faster.
- **Never touch sibling task directories** — other agents work there
  concurrently. Instance state (tt.db, sessions/windows) is scoped per
  checkout via `tt_config::state_scope()`; shared stores (settings, tracked
  repos) are one machine-wide copy.
- **Attribute a running process to its worktree before acting on it.** Several
  tasks run `tt-app`/vite at once and they are identical by process name, so
  `readlink /proc/<pid>/cwd` is the thing that tells you whose it is:

  ```sh
  pgrep -af "tt-app|vite"        # every instance on the machine
  readlink /proc/<pid>/cwd       # which checkout owns that one
  pkill -f "<task-name>.*tt-app" # kill only ever scoped to one task
  ```

  A bare `pkill -f "tauri dev"` or `killall` matches every task's processes,
  which is why `.claude/hooks/guard-task-pkill.sh` rejects the unscoped forms.

  **"The MCP tools aren't there"** now means what it looks like — the app for
  *your* checkout isn't running. Each instance serves its own MCP on its own
  `${tt:port 8787-8986}` claim (`TT_MCP_PORT` in the rendered `.env`), stamps
  that port into every terminal it spawns, and the plugin's `.mcp.json` expands
  `${TT_MCP_PORT:-8787}` — so a session talks to the app that spawned it.

  ```sh
  curl -s -m 5 -X POST "http://127.0.0.1:${TT_MCP_PORT:-8787}/mcp" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'  # empty => nobody serving
  tt task ports                                           # every checkout's claims
  ```

  A session started *outside* an app terminal has no `TT_MCP_PORT` and falls
  back to `8787`, reaching whichever checkout claimed it — usually the main one.

  **Don't reintroduce a shared port.** A machine-wide `8787` makes the instance
  that binds first answer every session from *its own* `tt.db`, so a
  `task_create` in one worktree silently lands on another checkout's board.
- Task logic lives in `crates/tt-tasks` (template grammar, removal guards,
  pure decisions) with shared orchestration in `tt_tasks::ops`; the CLI and
  the app's `task_create` command are thin shells over it. Change behavior
  there, not in the shells.
- **Migration state:** this repo's own checkouts still use the retired
  sibling layout (`~/code/p/towles-tool-repos/towles-tool-rs-primary` +
  `tasks/`). Running from an old-layout task still anchors correctly (the
  `.git` file's worktree pointer resolves to the main checkout), but new
  tasks land in `<checkout>/.claude/worktrees/`; old tasks drain as their
  branches merge.
- **Removing a task checkout goes through `tt_agentboard::task_removal`** —
  don't hand-roll the sequence. It untracks the dir from the shared
  `repos.json` and **closes** the bound board row, in that order, after the
  worktree leaves disk; `FinishedTask`/`RemovedTask` carry `dir`/`checkout`
  for exactly this. Closing (2026-07-22) replaced deleting: the row survives
  with a `TaskOutcome` (`done`/`abandoned`) and its `worktree_dir` cleared —
  the app's delete dialog asks which, headless callers (`tt task rm`, MCP)
  infer it via `TaskItem::inferred_outcome` (merged linked PR ⇒ done). Closed
  rows age into the archive (`archived_at`, `Store::archive_closed_tasks`,
  swept from `tt-collect`'s `sync_task_links` and the Board's "Archive done"
  button); `Store::delete_task` remains only behind the Board's explicit
  "Delete permanently", which refuses while a worktree is bound. Skip the
  untrack and a removed task's stale path lingers in the tracked-repos list
  forever, with the scheduler's `prs`/`issues` collectors retrying `gh`/`git`
  against a directory with no `.git` on every tick; skip the row-close and
  the board keeps a card claiming a worktree that no longer exists. `tt task
  rm`/`clean` and the app's `task_delete` are all shells over it.
