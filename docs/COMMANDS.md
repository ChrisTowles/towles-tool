# Commands, and how to verify a change

Every build/lint/test entry point, the comment-budget gate, and the two ways to
drive the real Tauri shell. [CLAUDE.md](../CLAUDE.md) keeps the short list.

Rust:

```sh
cargo run -p tt-cli -- <args>       # run the CLI (binary `tt`)
cargo run -p tt-cli -- task ls      # e.g. task, journal, collect
cargo fmt --check                   # formatting (rustfmt, 100-col)
cargo clippy --all -- -D warnings   # lint; warnings are errors
cargo test --all                    # unit + assert_cmd black-box tests
cargo comment-budget                # comment volume on the lines this branch adds — what CI runs
cargo comment-budget --all          # every file in the repo: the standing backlog
cargo comment-budget --all --report                  # the backlog as surfaces + worst files
cargo comment-budget --all --surface client-logic    # one surface, for a session spent fixing it
```

`comment-budget` is the one gate on comment sprawl, and the only one spanning
Rust and frontend (oxlint implements no comment-volume rule at all). Budgets are
per *surface* in **`comment-budget.toml`**; the mechanics live in
[`crates/comment-budget`](../crates/comment-budget/README.md), which is a
published package rather than repo-local tooling — see **Releasing
comment-budget** below. Three rules shape how you write:

- **`//!` is exempt, `///` and `//` are counted** — but only for a kind's first
  `exempt_free` lines (12, for Rust). Module docs are where the hard-won why
  lives; past that they count like anything else, so moving prose into `//!`
  buys nothing.
- **No baseline, no per-file exceptions** — a list of files allowed to fail is a
  ledger of debt nobody pays. The only escape is `comment-budget: allow(<reason>)`
  at the top of a file, and the reason is mandatory.
- **A file no surface claims is an error**, not a quiet skip: a tree nobody
  noticed was exempt reads exactly like passing.

CI judges only the lines a branch adds. `--all` is the repo-wide backlog, at
~500 errors — never wire it to `pull_request`, and never lower a budget to make
it pass.

## Releasing comment-budget

`crates/comment-budget` is the one thing here that ships to the public: MIT OR
Apache-2.0, to crates.io as source and to npm as `@towles-tool/comment-budget`
with a prebuilt binary per platform. To cut one, bump `Cargo.toml` **and**
`npm/comment-budget/package.json` (version plus all three `optionalDependencies`
pins) together — `npm_pins` fails if they disagree — then merge and dispatch
**Release comment-budget**, which defaults to a dry run. Rehearse locally with
`npm/pack.sh dist --wrapper` and `npm/publish.sh --dry-run dist/*.tgz`.

Both registries refuse to replace a published version, so re-running a
half-finished release is safe, and both authenticate by trusted publishing — the
job trades its OIDC id-token for a short-lived credential, so no token is stored
here. That trust can only be configured against a package that already exists,
so a **new** npm name is published by hand once.

`clippy --all`/`test --all` build `tt-vt` (needs zig 0.15.x), `tt-app` and
`tt-pane` (need webkit2gtk/GTK), and `tt-jarvis` (GTK dev-deps for its
benchmark, plus Bevy from a git fork — minutes of cold build). Without those
prereqs, use CI's variant:

```sh
cargo clippy --workspace --exclude tt-vt --exclude tt-app \
  --exclude tt-jarvis --exclude tt-pane --all-targets -- -D warnings
```

Those four are covered by CI's GTK-provisioned `rust-tauri` job instead, and
that job is path-gated — **a new crate needing GTK must be added to both the
`--exclude` list and the `vt_or_app` paths-filter in `.github/workflows/ci.yml`,
or it silently gets no Rust CI at all.**

Desktop app / frontend:

```sh
bun install                         # installs apps/client (bun workspaces)
bun run dev                         # tauri dev — app + Vite frontend (debug build; noticeably laggy)
bun start                           # reinstall `tt`, release build (`tauri build --no-bundle`), run — for daily driving
bun run dev:drive                   # like dev, but the window is automatable (live-drive)
bun run drive -- <verb>             # drive the dev:drive window (status|invoke|shot|click|…)
bun run e2e                         # regression suite vs the real shell (see below)
cd apps/client && bun run lint      # oxlint (types/react/unicorn/oxc rules; warnings are non-blocking)
cd apps/client && bun run format    # oxfmt, in place (100-col, matches rustfmt's width)
cd apps/client && bunx shadcn@latest add <name>   # vendor a shadcn/ui component
```

**`bun start` reinstalls `tt` first**, from the checkout it is about to run:
there is one `tt` on PATH for every checkout, so it otherwise drifts to whichever
worktree installed it last and the plugin's hooks fail on a flag that build
predates. Warm it costs about a second, it builds into its own `target/tt-cli`
(sharing the app's dir has each build invalidating the other's), and a failure
warns rather than holding back the app.

**Verifying UI/IPC changes — drive the real app.** Two ways, both hitting the
*actual* Tauri shell (WebKitGTK WebView + real Rust IPC), never a bare browser or
the mock dev server:

- **Live drive** — `bun run dev:drive` opens one automatable window (HMR, you use
  it normally); `node scripts/drive.mjs <verb>` drives *that same* window:
  `status`, `invoke <cmd> [json]` (real IPC), `eval "<js>"`, `shot <name>` (→
  `e2e/screenshots/<name>.png`, which you can `Read`), `click "<css>"`,
  `type "<css>" <text>`, `url <path>`, `console [--clear]`. This is the way to
  visually/behaviorally debug a change and see the result. **`shot` is blind to
  the native pane**: a `tt-pane` surface composites *above* the webview, so it's
  absent from a WebDriver capture however healthy it is. `winshot <name>`
  captures at the compositor level instead — it fullscreens the window on the
  test monitor first, which both identifies it among several tasks' identical
  windows and forces it unoccluded (no frame callbacks otherwise) — and
  `unplace` gives the monitor back. **A screenshot that
  looks right is not proof the render was clean** — React reports invalid
  markup as a runtime console error that nothing else here can see (no linter,
  no component tests), so every verb prints a `⚠ N console error(s)` summary
  and `console` dumps the detail. It's a plain-`fetch` client talking to the
  app's in-process WebDriver server — no WebdriverIO.
- **Regression suite** — `bun run e2e` runs WebdriverIO specs that spawn a fresh
  window, run, and exit (CI pass/fail). Specs in `e2e/specs/*.e2e.ts` are
  **read-only** (never write your real settings file); `bun run e2e:run` skips
  the rebuild.

Both are gated behind the `wdio` cargo feature + `VITE_WDIO` flag, so nothing
ships in normal/release builds. Ports come from the env files (`TT_DEV_PORT` in `.env.local`, or `.env` rendered by `tt task`;
webdriver = the `TT_E2E_WEBDRIVER_PORT` claim, falling back to `+3000`); `dev:drive` and `e2e` share a task's ports, so don't run
both at once in one task. Full docs + Linux gotchas: [e2e/README.md](../e2e/README.md).

**After finishing a task that touches the app, leave it running for Chris to
check.** Once the change builds/lints/tests clean, launch `bun start`
(release build, the daily-driving binary) as a background task — Bash with
`run_in_background: true`, not a foregrounded blocking call — as the last
step before ending the turn. This is a courtesy handoff so the real running
app is already on screen for Chris to click through and validate, rather than
him having to remember to launch it himself. It doesn't replace driving/
screenshotting the app yourself first for UI/IPC changes (previous section) —
do both when the change touches the app. Skip it for changes with nothing in
the app to look at (CLI-only, docs-only, crate-internal refactors with no
`tt-app`/`apps/client` surface).

> The binary is **`tt`**. The `ttr` → `tt` cutover from the TypeScript CLI
> happened 2026-07-13 — hard cutover, no `ttr` alias left behind (see
> [docs/CUTOVER.md](CUTOVER.md)).

## The CI variant of the Rust checks

`cargo clippy --all` / `cargo test --all` build `tt-vt` (needs zig 0.15.x),
`tt-app` and `tt-pane` (webkit2gtk/GTK) and `tt-jarvis` (Bevy from a git fork).
Without those prerequisites installed, use CI's variant, which excludes exactly
those four.

**A new crate needing GTK must be added to both that `--exclude` list and the
`vt_or_app` paths-filter in `.github/workflows/ci.yml`**, or it silently gets no
Rust CI at all.
