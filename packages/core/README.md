# tt-core

Skills for **discovering your unknowns** — Claude Code helpers built around the
map-vs-territory workflow from
[trq212, "The map is not the territory"](https://x.com/trq212/status/2073100352921215386).

The map is what you give Claude (prompts, skills, context). The territory is where
the work actually happens (the codebase, its real constraints). The gap between
them is your **unknowns**, and reducing them is the skill of agentic coding. Each
skill is a cheap way to find out what you didn't know — before it gets expensive
to fix.

## Commands

One command per technique, grouped by phase: before implementation,
plan/during, after. Each is a generic prompt you invoke; pass an optional
target as an argument.

### Before implementation

| Command             | Finds…           | Description                                                                       |
| -------------------- | ---------------- | --------------------------------------------------------------------------------- |
| `/tt:blindspot`   | unknown unknowns | Surface what you don't know you don't know in an unfamiliar area, and teach it.   |
| `/tt:brainstorm`  | unknown knowns   | Explore approaches / prototype with fake data so you can react before wiring.     |
| `/tt:interview`   | known unknowns   | Interview you one question at a time, architecture-changing questions first.      |
| `/tt:references`  | —                | Convey intent with a reference (ideally source code); reimplement its semantics.  |

### Plan & during implementation

| Command    | Finds…            | Description                                                                                                                                      |
| ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/tt:plan` | tweakable choices | Plan that leads with what you'll change (data models, types, UX), buries chores; then keeps implementation-notes with deviations while building. |

### After implementation

| Command           | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| `/tt:pitch`      | Package the work into one buy-in doc, demo first.            |
| `/tt:comprehend` | Report on the change + a quiz you must pass before merging.  |
| `/tt:memories`   | Review your memory files and recommend which to commit into CLAUDE.md. |
| `/tt:handoff`    | Write a short restart prompt for a fresh agent, copied to your clipboard. |

### Landing the work

A ladder: each command is the one before it plus one step. The git and `gh`
mechanics are `scripts/pr.sh`, which either finishes or stops with one `STOP:`
reason and one `FIX:`; the agent only writes the words and picks which files
belong.

| Command    | Description                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `/tt:pr`   | Branch off the default branch if needed, commit, push, open the PR (or update the open one). Targets a stacked parent branch's PR when there is one. |
| `/tt:prm`  | `/tt:pr`, then wait for checks and merge with the method the repo allows. Running it permits an admin merge: one `--admin` retry when branch protection refuses. Checks must still pass. |

`/towles-tool-app:done` (the app plugin) is the third rung: `/tt:prm`, then
delete the task from towles-tool.

## Mod: copy what Claude hands you

`hooks/register.tsx` is a Claude Code mod. When a turn ends with an answer, it
offers each `! <command>` Claude handed you to run in the prompt: a line,
indented or inside a fence, that opens with `! `, or an inline code span that
does. Each keeps its `! `, so a paste runs it in bash mode. SHAs, paths, links
and identifiers are never offered, nor is a message with no such command;
offers are deduplicated, at most three, with no model call.

```
1:  copy  ! gh pr merge 9 --squash --admin   a: copy all
2:  copy  ! gcloud auth login
```

The rows sit at the bottom of the band above the prompt, under anything another
mod draws there. A digit in the empty prompt (or a
click) copies that one; `a`, with the band focused, copies all of them in order,
apart enough that a clipboard manager keeps each entry. The offer clears when
the next turn starts. A session whose last three offers went uncopied is left
alone until you copy one, with a single probe every 30 minutes.

`hooks/clip.ts` is the pure logic `tests/` covers:

```sh
claude plugin validate packages/core
claude plugin test packages/core
```

## Installation

In Claude Code 2.1.275 or later, one step:

```text
/plugin install tt --marketplace ChrisTowles/towles-tool
```

Or from a shell:

```bash
claude plugin marketplace add ChrisTowles/towles-tool
claude plugin install tt@towles-tool
```

Restart Claude Code to load it. To pick up a new release:

```bash
claude plugin marketplace update towles-tool
claude plugin update tt@towles-tool
```
