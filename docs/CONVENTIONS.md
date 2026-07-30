# Conventions

The repo-wide rules that aren't obvious from the code. The few that bite
hardest are repeated in [CLAUDE.md](../CLAUDE.md); this is the whole list.

- **Frontend styling:** Tailwind + shadcn/ui only — no CSS modules, no
  hand-rolled stylesheets, no CSS-in-JS. Add components with
  `npx shadcn@latest add <name>`, don't hand-write Radix wrappers. The one
  carve-out is **animation**, where there are two idioms and the choice is not
  a preference: `tw-animate-css` classes (`data-open:animate-in …`, as the
  vendored `components/ui/*` use) for anything that animates while mounted,
  and the `motion` library for enter/exit of *dynamic lists* — a row removed
  from a backend snapshot unmounts before CSS can run, and only `motion`'s
  `AnimatePresence` can hold it on screen or `layout`-animate the rows that
  survive it. `apps/client/src/lib/rail-motion.ts` is the canonical config.
- **Every user action in the app must emit its OTel event** — event shape
  and exclusions in the `tt-telemetry` bullet in Architecture.
- **This is an agent interface, not a harness.** The classification is the
  rule. An agent interface owns the channel between the human and the agents
  in both directions — precision handing work in, comprehension getting it
  back (Karpathy's Software 3.0 framing: generation is cheap, *verification*
  is the bottleneck, and a GUI is what makes checking fast). A harness owns
  how the model does the work. Claude Code is the harness, and it gets smarter
  on a budget no one here can match; the interface is the half this repo can
  actually move. So a feature earns its place by widening the channel, never by
  trying to make the agent better at its job — that second kind can't even be
  evaluated here, since honestly improving a harness means A/B-testing against
  measured output quality, and anything cheaper is vibe testing under ten
  scenarios. The fix is never "test it better", it's "that belongs in the
  harness."

  The tell in code is a prompt authored in this repo that reads like a
  procedure — "implement it, then run /code-review, then rebase, then open the
  PR". Every prompt here asks a question and parses a JSON answer back (the
  `+` form's improvers via `task_suggest`, the calendar collectors), and every
  one is a user-editable string in settings rather than a pipeline compiled
  into the app: **a question this app acts on, never a procedure the model
  follows.** Wanting a multi-step agent workflow is legitimate — it belongs in
  `packages/core` as a slash command or skill, invoked deliberately, where
  Claude Code runs it.
- **No CLI-parity requirement.** The app is the primary product; each feature
  picks its natural surface. App-only features don't need a `tt` subcommand,
  and terminal-native tools (journal, gh, doctor) don't need app screens. What
  the CLI is *for* has narrowed to two things: terminal workflows the user
  runs by hand, and the process boundary a non-Rust caller needs — a Node
  script (`scripts/task-port.mjs` → `task env`/`task ports --probe`) or a
  shell hook (`gh-pr-nudge.sh` → `task nudge`). A headless duplicate of
  something the app already does on a schedule is neither. Either way, the
  logic lands in a
  Tauri-free `crates/` library with unit tests — the e2e harness is not the
  primary correctness seam.
- **Hard cutover, no back-compat shims** — replace, don't wrap. (No compat
  layers, no dual-name aliases — the `ttr`→`tt` rename left no `ttr` behind.)
- **`cargo ... | tail` reports `tail`'s exit code, not cargo's.** A failed
  build piped into `tail`/`grep`/`head` looks like success — this has already
  produced a confident "builds clean" on a build with four errors. Either
  redirect to a file and check the status separately
  (`cargo build > out.log 2>&1; echo $?`), or grep the output for `^error`
  and trust that rather than the exit code. Same trap with `set -o pipefail`
  absent in `scripts/*.sh`.
- **A measurement can outlive its subject and go *vacuous* — still reporting,
  no longer measuring.** Discarding transport errors (`let _ = …`) once let a
  harness keep "rendering" into a dead Wayland connection and report the
  embedded pane as *28% faster* than baseline, because nothing was being
  composited any more. Note the direction: removing the real work improved the
  number, so the bug arrived disguised as success. Two defences, both cheap:
  panic on the failure of whatever you are measuring *through*, and confirm
  pixels reached the screen (`cosmic-screenshot`, or a renderer-side capture
  like `tt_jarvis::jarvis::capture_frame_after` when the window may be
  offscreen) before believing any figure.
- **Test windows go on the secondary monitor.** Chris works on the primary
  while a harness runs, so a window landing there interrupts him once per run.
  Wayland clients cannot position their own toplevels; target an output by
  fullscreening on it — GTK `fullscreen_on_monitor(&screen, i)` or
  `xdg_toplevel.set_fullscreen(output)` — picking the monitor whose geometry
  `x > 0`, and no-opping on a single-monitor machine.
- **An occluded Wayland window receives no frame callbacks**, so anything
  vsync-paced stalls outright rather than slowing down, and reads as a hang.
  Correct compositor behaviour, and what the real pane wants; it also makes
  vsync arms unmeasurable on a desktop in use. Measure throughput with
  `AutoNoVsync`, in short runs — unthrottled presentation floods the
  compositor, which then hangs up with no protocol error. Monitors differ in
  refresh (60Hz secondary, 100Hz primary here), so vsync arms compare only
  within one screen.
- **Dev tooling must not hardcode ports/paths.** Chris runs multiple worktree
  tasks of this repo concurrently (see the Worktree tasks section above), so
  a fixed port, lockfile path, or other singleton resource makes copies
  collide. Ports belong in `.env.example` as `${tt:port A-B}` claims rendered
  per checkout by `tt task env` (what `scripts/dev-port.mjs` resolves) —
  never a hardcoded value like `1420`, and never a second derivation scheme
  outside the claim system.
- **No planning/implementation-notes docs committed to the repo** (e.g.
  `docs/<feature>/plan.html`, `implementation-notes.md`), even when a
  planning skill calls for writing one during implementation. Write them to
  the scratchpad directory instead — checked-in plans drift out of sync with
  the code and it's unclear which is authoritative. Git history retains any
  that were committed in the past; no need to preserve them elsewhere before
  removing.
- **TLS clients must trust the machine's trust store, not a bundled root
  list.** Chris develops behind a Zscaler-style TLS-inspecting proxy, which
  installs its own root CA into the OS trust store; `rustls` + `webpki-roots`
  (or any other bundled Mozilla root list) never sees that CA and fails to
  connect. Any new outbound HTTP/WebSocket client (`ureq`, `reqwest`,
  `tokio-tungstenite`, etc.) must be configured to verify against the OS store
  — `native-tls` (used by the Slack integration: `crates/tt-collect/src/
  slack.rs`'s `agent()`, `crates-tauri/tt-app/src/slack_socket.rs`) or an
  OS-native-roots rustls variant (e.g. `rustls-native-certs` /
  `rustls-tls-native-roots`) — never the crate's bundled-webpki-roots default.
