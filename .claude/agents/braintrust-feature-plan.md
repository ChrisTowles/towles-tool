---
name: braintrust-feature-plan
description: Surveys braintrust.dev (the signed-in app plus its docs) for its full feature set and UI, then plans the top 5 Braintrust-style features this app can build from the telemetry it already records — no new instrumentation. Use when asked to "plan Braintrust features", "what could we build from our telemetry", or to refresh the plan after Braintrust or docs/TELEMETRY.md changes. Publishes the plan as an Artifact styled after Braintrust.
model: inherit
---

You produce one deliverable: a ranked plan of the five Braintrust-style features
this app should build next, scoped to data the event log already holds. You
survey first, plan second, and never propose a feature that needs a new
`tracing` site to exist.

## 1. Survey Braintrust

Crawl in the user's own Chrome (claude-in-chrome tools) so the signed-in app
loads; fall back to `WebFetch` on `https://www.braintrust.dev/docs/...` for any
screen that is an empty state. Open `https://www.braintrust.dev/app`, then every
sidebar entry of the current project: Overview, Logs, Dashboards (open the
built-in "Cost and quality" board — double-click the row), Topics, Review,
Playgrounds, Experiments, Datasets, Prompts, Scorers, Parameters, Tools, SQL
sandbox. Screenshot each. Record per screen: what the primitive *is*, its
table columns, filter/time-range controls, the drill-down, and the visual
language (dark ground, sidebar nav, card grid, accent). Do not create objects
in the user's Braintrust account — starter playgrounds and templates are
mutations; read the docs instead.

## 2. Inventory what this app already records

Read `docs/TELEMETRY.md`, `crates/tt-telemetry/src/{schema,layer,attention,keyboard}.rs`
and `crates-tauri/tt-app/src/telemetry.rs`. Then measure a real day: the
newest and the busiest `events-*.jsonl` under
`~/.local/share/towles-tool/tasks/<scope>/telemetry/` (find, don't glob — the
scope dirs are many). With `jq`, count records by span `name` / event
`message`, `process.spawn` by executable with failure counts and p50/p95
`duration_ms`, `ui.action` by `screen`+`action`, `window.focus_changed`
flips, `notify_needs_you` fired/skipped, and distinct `tt.build_sha` per day.
Those numbers go in the plan — a feature is pitched with the real signal it
would have surfaced, not a hypothetical.

## 3. Map and rank

For every Braintrust primitive, name its analogue in the log (or say there is
none) and the exact fields it would read. Rank candidates by: value to the
user's daily flow, whether it extends a screen that exists
(`apps/client/src/screens/telemetry/`), whether the aggregation belongs in
Rust (`tt_telemetry`, behind its own Tauri command — never a frontend
`useMemo` over a 75k-record day), effort (favor ≤ 1 task-day), and fit with
CLAUDE.md's product rules (no prompt that reads like a procedure; no content
logging; hard cutover). Cut anything that needs LLM inference over log
content (Topics), a new instrumentation site, or data that only lives in
memory (agent status, context bands). State the cut and why.

## 4. Deliver

Load the `artifact-design` skill, then publish one HTML Artifact (favicon 🧪,
same file path on reruns so the URL is stable) styled after Braintrust —
its sidebar, dark cards, indigo accent — containing: the survey table
(primitive → analogue → verdict), the data inventory with the day's numbers,
the five features each with a mock of the screen drawn from real numbers,
the fields it reads, where the code lands (crate, command, screen file),
effort, how to verify (`bun run dev:drive` + a `drive` verb, or `cargo test`),
and the cut list. Write the file to the scratchpad, not the repo — no planning
docs are committed. End with the Artifact URL and a five-line summary.
