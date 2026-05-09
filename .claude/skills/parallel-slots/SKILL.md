---
name: parallel-slots
description: Use when the user wants to dispatch parallel Claude Code agents across the towles-tool slot clones, asks to "fan out", "run N in parallel", "use the slots", or wants to coordinate multiple isolated working copies of the same repo. Explains the slot directory layout, when to fan out vs. stay in primary, and how AgentBoard ties the slots together.
user_invocable: true
---

# Parallel slots — towles-tool

The slot pattern lets you run independent Claude Code sessions on the same repo without stepping on each other. Mirrors Boris Cherny's "5 terminal tabs, each a separate git checkout" workflow.

## Layout

```
~/code/p/towles-tool-repos/
  towles-tool-primary/   # interactive work, default for `tt`
  towles-tool-slot-1/    # parallel agent slot
  towles-tool-slot-2/
  towles-tool-slot-3/
  towles-tool-slot-4/
  towles-tool-slot-5/
```

Each slot is a full clone of the same GitHub remote, not a worktree. They check out branches independently. AgentBoard (`packages/agentboard/`) renders a tmux sidebar that watches all slots and surfaces completion via the stop-hook sweep.

## When to fan out

Fan out (use slots) when:

- Three or more independent tasks would benefit from running simultaneously (e.g. one PR, one bug, one refactor).
- A task is risky and you want a clean, throwaway slot that won't pollute primary's working tree.
- You're iterating on the agent harness itself and want to leave primary stable.

Stay in primary when:

- The work is sequential or all the changes need to land in the same commit.
- You're reading/exploring; spinning a slot just adds overhead.

## Dispatch flow

1. Pick a free slot (any slot whose AgentBoard pane is idle).
2. `cd` into it and confirm `git status` is clean.
3. `git fetch origin && git switch main && git pull` to sync.
4. Branch off: `git switch -c <topic-branch>`.
5. Hand the task to Claude in that slot — either via the AgentBoard TUI or by running `tt auto-claude` with a prompt.
6. Watch the AgentBoard pane for completion. The stop-hook prints results back to the sidebar.

## Coordination rules

- Never run two agents on the _same_ branch in two slots — push/pull races destroy work.
- Branch names should be unique per slot for the duration of the run.
- If a slot's working tree is dirty when you arrive, treat it as in-progress work — investigate before resetting.
- Pre-commit hook (format + lint:fix + typecheck) runs in every slot, so `--no-verify` is forbidden.

## Verifying a slot's output

Before merging from a slot, run `/verify` (or the `verify-app` subagent) inside it. Don't trust the slot's own self-report; the agent that wrote the change is not the right reviewer.

## Cleanup

After a slot's branch is merged, in that slot:

```
git switch main
git pull
git branch -d <topic-branch>
```

Or use `compound-engineering:ce-clean-gone-branches` to bulk-prune.

## Anti-patterns

- Spinning all 5 slots on the same task "for redundancy". You'll spend the time merging conflicts.
- Treating slots as long-lived workspaces. They are scratch checkouts — keep them transient.
- Editing files in primary while a slot has them open. Stay in one or the other for any given file.
